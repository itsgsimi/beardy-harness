/**
 * Model-facing creation, replacement, and removal of flat skills in either the
 * workspace root or the Harness-home user root. The filesystem service owns
 * mutation and sandbox semantics; this module owns the skill document format,
 * target restriction, scope selection, and the approval gate.
 * @module @deepseek-ai/dsh-tool-skill/manage
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { writeObservedText, type FileSystem } from '@deepseek-ai/dsh-fs'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'

type ManageAction = 'check' | 'create' | 'update' | 'delete'
type SkillScope = 'workspace' | 'user'

interface ManageArgs {
  action: ManageAction
  name: string
  description?: string
  content?: string
  when_to_use?: string
  model_invocable?: boolean
  user_invocable?: boolean
  scope?: SkillScope
}

interface MutationResult {
  action: ManageAction
  name: string
  path: string
  status: 'created' | 'updated' | 'deleted'
}

interface CheckResult {
  action: 'check'
  name: string
  errors: string[]
  warnings: string[]
  bytes: number
}

type ManageResult = MutationResult | CheckResult

interface LintResult {
  errors: string[]
  warnings: string[]
  bytes: number
  description: string
  body: string
}

/** Deployment stance for the management tool beyond its mere presence. */
export interface SkillManageOptions {
  /** Offer and accept the `user` scope in the Harness home; false refuses it per call. */
  readonly enableUserScope: boolean
  /** Route every mutation through the approval service before touching a file. */
  readonly requireApproval: boolean
  /** Allow one approved user-scope mutation outside the workspace. */
  readonly allowApprovedHomeWrites: boolean
  /** Maximum UTF-8 byte length of the written Markdown body. */
  readonly skillBodyMaxBytes: number
}

/** Longest description excerpt shown in an approval reason. */
const REASON_EXCERPT_CHARS = 120
const PREVIEW_CHARS = 300

function excerpt(value: string): string {
  const text = value.replaceAll(/\s+/g, ' ').trim()
  return text.length <= REASON_EXCERPT_CHARS ? text : `${text.slice(0, REASON_EXCERPT_CHARS)}…`
}

/** Ask the approval service; any outcome other than `allowed-once` refuses the mutation. */
async function approvedForMutation(
  ctx: Context,
  exec: ToolExecution,
  args: ManageArgs,
  scope: SkillScope,
  preview?: string,
): Promise<void> {
  const detail = `${args.action} ${scope} skill "${args.name}" (${excerpt(args.description ?? 'no description')})`
  if (exec.agent === undefined) {
    throw new Error(`skill write needs approval (${detail}), but this call has no Agent-backed session`)
  }
  const approval = ctx.get('approval')
  if (approval === undefined) {
    throw new Error(`skill write needs approval (${detail}); no approval answerer is mounted, so the write was refused`)
  }
  const outcome = await approval.request({
    agent: exec.agent,
    toolName: 'skill_manage',
    callId: exec.callId,
    reason: `Skill management: ${detail}${preview === undefined ? '' : `\n${preview}`}`,
    signal: exec.signal,
  })
  if (outcome !== 'allowed-once') {
    throw new Error(`skill ${args.action} was not approved (${outcome}); nothing changed`)
  }
}

/**
 * Register the skill-management tool over the supplied filesystem.
 * @param ctx - context carrying tool and optional approval services.
 * @param fs - filesystem used for skill reads and mutations.
 * @param options - resolved management scopes, paths, and approval policy.
 */
export function applySkillManageTool(
  ctx: Context,
  fs: FileSystem,
  options: SkillManageOptions,
): void {
  ctx.tools.register(defineTool({
    name: 'skill_manage',
    description: 'Check, create, update, or delete a skill. Check returns lint findings without writing. Workspace skills are flat Markdown files under .agents/skills; user skills live under the Harness home and load in every session. Check a draft before saving a reusable workflow.',
    parameters: {
      action: { type: 'string', required: true, enum: ['check', 'create', 'update', 'delete'], description: 'Operation to perform. Check validates without writing or approval.' },
      name: { type: 'string', required: true, description: 'Kebab-case skill name.' },
      description: { type: 'string', description: 'Short description for check, create, or update.' },
      content: { type: 'string', description: 'Markdown instructions for check, create, or update.' },
      when_to_use: { type: 'string', description: 'Routing guidance for check, create, or update; short or missing guidance yields a warning.' },
      model_invocable: { type: 'boolean', description: 'Whether the model may load the skill; defaults to true.' },
      user_invocable: { type: 'boolean', description: 'Whether a user may invoke the skill with /name; defaults to true.' },
      scope: { type: 'string', enum: ['workspace', 'user'], description: 'Where the skill lives: the current workspace (default) or the Harness home for every session. User scope requires enableUserSkillManagement.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, enum: ['check', 'create', 'update', 'delete'] },
          name: { type: 'string', required: true },
          path: { type: 'string' },
          status: { type: 'string', enum: ['created', 'updated', 'deleted'] },
          errors: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
          bytes: { type: 'number' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.action === 'check'
        ? JSON.stringify({ errors: value.errors, warnings: value.warnings, bytes: value.bytes })
        : `${value.status} skill ${value.name} at ${value.path}` }],
    },
    async execute(args: ManageArgs, exec): Promise<ManageResult> {
      const scope: SkillScope = args.scope ?? 'workspace'
      if (scope === 'user' && !options.enableUserScope) {
        throw new Error('user-scope skill management is disabled by configuration')
      }
      if (args.action === 'check') {
        const { errors, warnings, bytes } = await lintSkill(ctx, args, exec, options.skillBodyMaxBytes)
        return { action: 'check', name: args.name, errors, warnings, bytes }
      }
      validateName(args.name)
      const lint = args.action === 'delete' ? undefined : await lintSkill(ctx, args, exec, options.skillBodyMaxBytes)
      if (lint !== undefined && lint.errors.length > 0) throw new Error(`skill validation failed: ${lint.errors.join('; ')}`)
      const paths = scopePaths(exec, scope)
      const rootPath = paths.rootPath
      // Carry THIS session's policy on every mutation. Without it the sandboxed
      // filesystem falls back to the deployment default (its mode plus the
      // fallback workspace root), which refused paths inside the calling
      // session's own workspace — the standing bug this closes.
      const sandboxPolicy = sessionPolicy(ctx, exec)
      const policyService: SandboxPolicyService | undefined = ctx.get('sandboxPolicy')
      const allowanceFor = (path: string) => scope === 'user' && options.allowApprovedHomeWrites
        && sandboxPolicy?.mode === 'workspace-write'
        ? policyService?.approveFsMutation(sandboxPolicy, paths.boundaryPath, path)
        : undefined
      const filePath = join(rootPath, `${args.name}.md`)
      const filePathInfo = await fs.lstat(filePath, undefined, exec.signal)
      if (filePathInfo?.type === 'symlink') throw new Error(`skill "${args.name}" is a symbolic link and cannot be managed`)
      const target = await fs.resolve(filePath, { signal: exec.signal })
      const root = await fs.resolve(rootPath, { signal: exec.signal })
      const boundary = await fs.resolve(paths.boundaryPath, { signal: exec.signal })
      if (!fs.contains(boundary, root)) {
        throw new Error(scope === 'user' ? 'user skill directory escaped the Harness home' : 'workspace skill directory escaped the workspace')
      }
      if (!fs.contains(root, target)) throw new Error('skill target escaped the skill directory')

      const existing = await fs.stat(target, exec.signal)
      if (args.action === 'delete') {
        if (options.requireApproval) await approvedForMutation(ctx, exec, args, scope)
        if (existing === undefined) throw new Error(`skill "${args.name}" does not exist in the ${scope} skill directory`)
        if (existing.type !== 'file') throw new Error(`skill "${args.name}" is not a regular file`)
        await fs.removeFile(target, exec.signal, sandboxPolicy, allowanceFor(filePath), existing.version)
        ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
        return { action: args.action, name: args.name, path: target.displayPath, status: 'deleted' }
      }

      const content = renderSkillFile(args, lint as LintResult)
      if (args.action === 'create' && existing !== undefined) {
        throw new Error(`skill "${args.name}" already exists; use update instead`)
      }
      if (args.action === 'update' && existing === undefined) {
        throw new Error(`skill "${args.name}" does not exist; use create instead`)
      }
      if (existing !== undefined && existing.type !== 'file') {
        throw new Error(`skill "${args.name}" is not a regular file`)
      }
      const previous = existing === undefined ? '' : await fs.readText(target, exec.signal)
      await (options.requireApproval
        ? approvedForMutation(ctx, exec, args, scope, approvalPreview(previous, content, lint as LintResult))
        : Promise.resolve())
      const directory = await fs.resolve(rootPath, { signal: exec.signal })
      if (await fs.stat(directory, exec.signal) === undefined) {
        await fs.makeDirectory(directory, exec.signal, sandboxPolicy, allowanceFor(rootPath))
      }
      const outcome = await writeObservedText(ctx, fs, target, content, existing, exec, exec.signal, sandboxPolicy, allowanceFor(filePath))
      return {
        action: args.action,
        name: args.name,
        path: target.displayPath,
        status: outcome.operation === 'create' ? 'created' : 'updated',
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `${args.action} skill ${args.name}`, kind: args.action === 'delete' ? 'delete' : args.action === 'check' ? 'read' : 'execute', rawInput: args.name }
    },
  }))
}

function requireAgent(exec: ToolExecution): Agent {
  if (exec.agent === undefined) throw new Error('skill_manage requires an Agent-backed session')
  return exec.agent
}

/**
 * The calling session's standing sandbox policy, resolved the way `write` and
 * `edit` resolve it: the session supplies both its mode override and its
 * immutable cwd as the workspace boundary. An agentless call keeps the
 * deployment fallback, exactly as before.
 */
function sessionPolicy(ctx: Context, exec: ToolExecution): ReturnType<SandboxPolicyService['resolve']> | undefined {
  const policyService: SandboxPolicyService | undefined = ctx.get('sandboxPolicy')
  return policyService?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
}

/** The scope's skill root and the directory it must stay inside; workspace scope is the only one needing a cwd. */
function scopePaths(exec: ToolExecution, scope: SkillScope): { rootPath: string; boundaryPath: string } {
  if (scope === 'user') return { rootPath: join(resolveDshHome(), 'skills'), boundaryPath: resolveDshHome() }
  const cwd = requireAgent(exec).session.header.cwd
  if (cwd === undefined) throw new Error('skill_manage requires a workspace cwd')
  return { rootPath: join(cwd, '.agents', 'skills'), boundaryPath: cwd }
}

function validateName(name: string): void {
  if (!isSkillName(name)) throw new Error(`invalid skill name "${name}"`)
}

/** Validate the exact body that would be written and warn about weak routing or catalog overlap. */
async function lintSkill(ctx: Context, args: ManageArgs, exec: ToolExecution, maxBytes: number): Promise<LintResult> {
  const errors: string[] = []
  const warnings: string[] = []
  if (!isSkillName(args.name)) errors.push(`invalid skill name "${args.name}"`)
  const description = args.description?.trim()
  if (!description) errors.push('description is required for create and update')
  if (args.content === undefined || args.content.trim().length === 0) errors.push('content is required for create and update')
  const body = args.content === undefined ? '' : `${args.content.replace(/\n*$/, '')}\n`
  const bytes = Buffer.byteLength(body, 'utf8')
  if (bytes > maxBytes) errors.push(`skill body is ${String(bytes)} bytes; limit is ${String(maxBytes)} bytes`)
  if (args.content?.startsWith('---\n') || args.content?.startsWith('---\r\n')) {
    errors.push('content must contain the Markdown body only; frontmatter comes from the name and description fields')
  }
  if (description !== undefined && description.length < 30) warnings.push('description is short; explain when this skill applies')
  if (body.trim().length > 0 && body.trim().length < 80) warnings.push('body is short; include the reusable steps and any constraints')
  const whenToUse = args.when_to_use?.trim()
  if (!whenToUse) warnings.push('whenToUse is missing; add a concrete trigger')
  else if (whenToUse.length < 25) warnings.push('whenToUse is short; name the situation that should trigger this skill')
  const catalog = await ctx.skills.list({ cwd: exec.agent?.session.header.cwd, signal: exec.signal, scope: exec.agent })
  for (const skill of catalog) {
    if (skill.name === args.name) {
      if (args.action !== 'update') warnings.push(`catalog already contains skill "${skill.name}"`)
      continue
    }
    if (description !== undefined && description.length >= 24
      && skill.description.toLowerCase().includes(description.toLowerCase())) {
      warnings.push(`description overlaps catalog skill "${skill.name}"`)
      break
    }
  }
  return { errors, warnings, bytes, description: description ?? '', body }
}

/** Show the changed span only; large bodies cannot fill an approval request. */
function approvalPreview(previous: string, next: string, lint: LintResult): string {
  let prefix = 0
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix += 1
  let oldEnd = previous.length
  let newEnd = next.length
  while (oldEnd > prefix && newEnd > prefix && previous[oldEnd - 1] === next[newEnd - 1]) {
    oldEnd -= 1
    newEnd -= 1
  }
  const bounded = (text: string): string => text.length <= PREVIEW_CHARS
    ? text
    : `${text.slice(0, PREVIEW_CHARS)}… (${String(text.length - PREVIEW_CHARS)} chars omitted)`
  return [
    `Lint: 0 errors, ${String(lint.warnings.length)} warnings; body ${String(lint.bytes)} bytes.`,
    ...lint.warnings.map(warning => `Warning: ${warning}`),
    `Diff at character ${String(prefix)}:`,
    `- ${bounded(previous.slice(prefix, oldEnd))}`,
    `+ ${bounded(next.slice(prefix, newEnd))}`,
  ].join('\n')
}

function renderSkillFile(args: ManageArgs, lint: LintResult): string {
  const { description, body } = lint
  const frontmatter = [
    `name: ${JSON.stringify(args.name)}`,
    `description: ${JSON.stringify(description)}`,
    ...args.when_to_use?.trim() ? [`whenToUse: ${JSON.stringify(args.when_to_use.trim())}`] : [],
    ...(args.model_invocable === false ? ['disable-model-invocation: true'] : []),
    ...(args.user_invocable === false ? ['user-invocable: false'] : []),
  ]
  return `---\n${frontmatter.join('\n')}\n---\n\n${body.replace(/\n*$/, '')}\n`
}
