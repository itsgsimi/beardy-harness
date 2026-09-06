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
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'

type ManageAction = 'create' | 'update' | 'delete'
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

interface ManageResult {
  action: ManageAction
  name: string
  path: string
  status: 'created' | 'updated' | 'deleted'
}

/** Deployment stance for the management tool beyond its mere presence. */
export interface SkillManageOptions {
  /** Offer and accept the `user` scope in the Harness home; false refuses it per call. */
  readonly enableUserScope: boolean
  /** Route every mutation through the approval service before touching a file. */
  readonly requireApproval: boolean
}

/** Longest description excerpt shown in an approval reason. */
const REASON_EXCERPT_CHARS = 120

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
    reason: `Skill management: ${detail}`,
    signal: exec.signal,
  })
  if (outcome !== 'allowed-once') {
    throw new Error(`skill ${args.action} was not approved (${outcome}); nothing changed`)
  }
}

/** Register the skill-management tool over the supplied filesystem. */
export function applySkillManageTool(
  ctx: Context,
  fs: FileSystem,
  options: SkillManageOptions,
): void {
  ctx.tools.register(defineTool({
    name: 'skill_manage',
    description: 'Create, update, or delete a skill. Workspace skills are stored as flat Markdown files under .agents/skills and load in that workspace; user-scope skills live under the Harness home and load in every session. Skills become available to the skill loader after the catalog refreshes. When you work out a non-trivial workflow, record it with `skill_manage` so it loads only when relevant.',
    parameters: {
      action: { type: 'string', required: true, enum: ['create', 'update', 'delete'], description: 'Operation to perform.' },
      name: { type: 'string', required: true, description: 'Kebab-case skill name.' },
      description: { type: 'string', description: 'Short description for create or update.' },
      content: { type: 'string', description: 'Markdown instructions for create or update.' },
      when_to_use: { type: 'string', description: 'Optional routing guidance for create or update.' },
      model_invocable: { type: 'boolean', description: 'Whether the model may load the skill; defaults to true.' },
      user_invocable: { type: 'boolean', description: 'Whether a user may invoke the skill with /name; defaults to true.' },
      scope: { type: 'string', enum: ['workspace', 'user'], description: 'Where the skill lives: the current workspace (default) or the Harness home for every session. User scope requires enableUserSkillManagement.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, enum: ['create', 'update', 'delete'] },
          name: { type: 'string', required: true },
          path: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['created', 'updated', 'deleted'] },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.status} skill ${value.name} at ${value.path}` }],
    },
    async execute(args: ManageArgs, exec): Promise<ManageResult> {
      const scope: SkillScope = args.scope ?? 'workspace'
      if (scope === 'user' && !options.enableUserScope) {
        throw new Error('user-scope skill management is disabled by configuration')
      }
      validateName(args.name)
      if (options.requireApproval) await approvedForMutation(ctx, exec, args, scope)
      const paths = scopePaths(exec, scope)
      const rootPath = paths.rootPath
      await fs.makeDirectory(await fs.resolve(rootPath, { signal: exec.signal }), exec.signal)
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
        if (existing === undefined) throw new Error(`skill "${args.name}" does not exist in the ${scope} skill directory`)
        if (existing.type !== 'file') throw new Error(`skill "${args.name}" is not a regular file`)
        await fs.removeFile(target, exec.signal)
        ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
        return { action: args.action, name: args.name, path: target.displayPath, status: 'deleted' }
      }

      const content = renderSkillFile(args)
      if (args.action === 'create' && existing !== undefined) {
        throw new Error(`skill "${args.name}" already exists; use update instead`)
      }
      if (args.action === 'update' && existing === undefined) {
        throw new Error(`skill "${args.name}" does not exist; use create instead`)
      }
      if (existing !== undefined && existing.type !== 'file') {
        throw new Error(`skill "${args.name}" is not a regular file`)
      }
      const expected = existing === undefined
        ? { kind: 'createIfAbsent' as const }
        : { kind: 'replaceIfVersion' as const, version: existing.version }
      ctx.emit('fs/observed', target, existing === undefined
        ? { kind: 'absent' }
        : { kind: 'present', version: existing.version }, exec)
      const outcome = await fs.writeText(target, content, expected, exec.signal)
      ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
      return {
        action: args.action,
        name: args.name,
        path: target.displayPath,
        status: outcome.operation === 'create' ? 'created' : 'updated',
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `${args.action} skill ${args.name}`, kind: args.action === 'delete' ? 'delete' : 'execute', rawInput: args.name }
    },
  }))
}

function requireAgent(exec: ToolExecution): Agent {
  if (exec.agent === undefined) throw new Error('skill_manage requires an Agent-backed session')
  return exec.agent
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

function renderSkillFile(args: ManageArgs): string {
  const description = args.description?.trim()
  if (description === undefined || description.length === 0) throw new Error('description is required for create and update')
  if (args.content === undefined) throw new Error('content is required for create and update')
  const frontmatter = [
    `name: ${JSON.stringify(args.name)}`,
    `description: ${JSON.stringify(description)}`,
    ...args.when_to_use?.trim() ? [`whenToUse: ${JSON.stringify(args.when_to_use.trim())}`] : [],
    ...(args.model_invocable === false ? ['disable-model-invocation: true'] : []),
    ...(args.user_invocable === false ? ['user-invocable: false'] : []),
  ]
  return `---\n${frontmatter.join('\n')}\n---\n\n${args.content.replace(/\n*$/, '')}\n`
}
