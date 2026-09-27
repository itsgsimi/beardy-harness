/**
 * Model-facing `memory` tool: one narrow editor for the two curated memory files under the Harness
 * home. The filesystem service owns mutation and sandbox semantics; this module owns target
 * restriction, the document rules from {@link @deepseek-ai/dsh-tool-memory/store}, and the approval gate.
 * @module @deepseek-ai/dsh-tool-memory/tool
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { writeObservedText, type FileSystem } from '@deepseek-ai/dsh-fs'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  applyOperation,
  assertWithinCap,
  MEMORY_FILE_NAMES,
  parseEntries,
  serializeEntries,
} from './store.ts'
import type { MemoryOperation, MemoryTarget } from './store.ts'
import { parseTopic, retireTopic, topicVersion, TOPIC_SLUG, validateTopicSlug } from './topic.ts'

/** Complete plugin configuration the tool needs at call time. */
export interface MemoryToolConfig {
  /** Absolute Harness-home directory holding USER.md and MEMORY.md. */
  readonly dshHome: string
  /** Character cap for USER.md. */
  readonly userMaxChars: number
  /** Character cap for MEMORY.md. */
  readonly memoryMaxChars: number
  /** Character cap for one entry. */
  readonly entryMaxChars: number
  readonly topicMaxChars: number
  readonly topicMaxFiles: number
  readonly topicReadMaxChars: number
  /** Route every write through the approval service before touching the file. */
  readonly requireApproval: boolean
  /** Issue one exact home-file allowance only after approval. */
  readonly allowApprovedHomeWrites: boolean
}

interface MemoryArgs {
  target: MemoryTarget | 'topic'
  action: 'list' | 'read' | 'add' | 'replace' | 'remove'
  content?: string
  old_text?: string
  topic?: string
  expected_version?: string
  include_retired?: boolean
  superseded_by?: string
}

interface MemoryResult {
  target: MemoryTarget | 'topic'
  entries?: number
  characters?: number
  limit?: number
  topic?: string
  version?: string
  body?: string
  status?: string
  topics?: { slug: string; status: string; updated: string }[]
}

/** Read topic files only on demand; guarded mutations preserve the observed document shape. */
async function executeTopic(
  ctx: Context, config: MemoryToolConfig, fs: FileSystem, args: MemoryArgs, exec: ToolExecution,
): Promise<MemoryResult> {
  const directoryPath = join(config.dshHome, 'memories')
  const directoryInfo = await fs.lstat(directoryPath, undefined, exec.signal)
  if (directoryInfo?.type === 'symlink') throw new Error('memories directory is a symbolic link')
  const directory = await fs.resolve(directoryPath, { signal: exec.signal })
  const home = await fs.resolve(config.dshHome, { signal: exec.signal })
  if (!fs.contains(home, directory)) throw new Error('memories directory escaped the Harness home')
  const files = directoryInfo === undefined ? [] : (await fs.listDir(directory, exec.signal))
    .filter(item => item.name.endsWith('.md'))
  if (files.length > config.topicMaxFiles) {
    throw new Error(`topic store has ${String(files.length)} files, over the ${String(config.topicMaxFiles)}-file cap`)
  }
  if (args.action === 'list') {
    const topics: { slug: string; status: string; updated: string }[] = []
    for (const item of files) {
      const slug = item.name.slice(0, -3)
      if (!TOPIC_SLUG.test(slug)) throw new Error(`topic file ${item.name} has an invalid slug`)
      if ((await fs.lstat(item.target.displayPath, undefined, exec.signal))?.type === 'symlink') {
        throw new Error(`topic ${item.name} is a symbolic link`)
      }
      const info = await fs.stat(item.target, exec.signal)
      if (info === undefined) throw new Error(`topic ${slug} disappeared during listing`)
      if ((info.size ?? Number.POSITIVE_INFINITY) > config.topicMaxChars * 4) {
        throw new Error(`topic ${slug} exceeds its configured file cap`)
      }
      const body = await fs.readText(item.target, exec.signal)
      if (body.length > config.topicMaxChars) {
        throw new Error(`topic ${slug} version ${topicVersion(body)} exceeds the ${String(config.topicMaxChars)}-character file cap; current excerpt: ${JSON.stringify(body.slice(0, 500))}`)
      }
      const metadata = parseTopic(body)
      if (metadata.status === 'retired' && args.include_retired !== true) continue
      topics.push({ slug, status: metadata.status, updated: metadata.updated })
    }
    return { target: 'topic', topics }
  }
  // validateFields requires a slug for every non-list topic action.
  const slug = args.topic as string
  const path = join(directoryPath, `${slug}.md`)
  const pathInfo = await fs.lstat(path, undefined, exec.signal)
  if (pathInfo?.type === 'symlink') throw new Error(`topic ${slug} is a symbolic link`)
  const target = await fs.resolve(path, { signal: exec.signal })
  if (!fs.contains(directory, target)) throw new Error(`topic ${slug} escaped the memories directory`)
  const existing = await fs.stat(target, exec.signal)
  if ((existing?.size ?? 0) > config.topicMaxChars * 4) {
    throw new Error(`topic ${slug} exceeds its configured file cap`)
  }
  const currentBody = existing === undefined ? undefined : await fs.readText(target, exec.signal)
  if (args.action === 'read') {
    if (existing === undefined) throw new Error(`topic ${slug} does not exist`)
    const body = currentBody as string
    if (body.length > config.topicMaxChars) {
      throw new Error(`topic ${slug} version ${topicVersion(body)} exceeds the ${String(config.topicMaxChars)}-character file cap; current excerpt: ${JSON.stringify(body.slice(0, 500))}`)
    }
    const metadata = parseTopic(body)
    if (body.length > config.topicReadMaxChars) {
      throw new Error(`topic ${slug} version ${topicVersion(body)} exceeds the ${String(config.topicReadMaxChars)}-character read cap; excerpt: ${JSON.stringify(body.slice(0, 500))}`)
    }
    return { target: 'topic', topic: slug, version: topicVersion(body), body, status: metadata.status, characters: body.length, limit: config.topicReadMaxChars }
  }
  if (args.action === 'add' && existing !== undefined) throw new Error(`topic ${slug} already exists; read it and use replace`)
  if (args.action !== 'add' && existing === undefined) throw new Error(`topic ${slug} does not exist`)
  if (args.action === 'add' && files.length >= config.topicMaxFiles) {
    throw new Error(`topic store is full at ${String(config.topicMaxFiles)} files, including retired topics; replace or consolidate an existing topic`)
  }
  if (currentBody !== undefined && args.expected_version !== topicVersion(currentBody)) {
    throw new Error(`topic ${slug} changed; read its current version ${topicVersion(currentBody)} before retrying; file cap ${String(config.topicMaxChars)} characters; current excerpt: ${JSON.stringify(currentBody.slice(0, 500))}`)
  }
  let body: string
  if (args.action === 'remove') {
    body = retireTopic(currentBody as string, new Date().toISOString().slice(0, 10), args.superseded_by)
  } else {
    if (args.action === 'replace') parseTopic(currentBody as string)
    if (args.content === undefined) throw new Error(`topic ${args.action} requires a complete Markdown document in content`)
    body = args.content
    const metadata = parseTopic(body)
    if (args.action === 'add' && metadata.status !== 'active') throw new Error('new topics must have active status')
  }
  if (body.length > config.topicMaxChars) {
    throw new Error(`topic ${slug} would be ${String(body.length)} characters, over the ${String(config.topicMaxChars)}-character cap; version ${currentBody === undefined ? 'absent' : topicVersion(currentBody)}; current excerpt: ${JSON.stringify(currentBody?.slice(0, 500) ?? '')}`)
  }
  if (config.requireApproval) await approvedForWrite(ctx, exec, `${slug}.md`, args)
  const policyService: SandboxPolicyService | undefined = ctx.get('sandboxPolicy')
  const sandboxPolicy = policyService?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
  const allowanceFor = (path: string) => config.allowApprovedHomeWrites && sandboxPolicy?.mode === 'workspace-write'
    ? policyService?.approveFsMutation(sandboxPolicy, config.dshHome, path)
    : undefined
  if (directoryInfo === undefined) {
    await fs.makeDirectory(directory, exec.signal, sandboxPolicy, allowanceFor(directoryPath))
  }
  await writeObservedText(ctx, fs, target, body, existing, exec, exec.signal, sandboxPolicy, allowanceFor(path))
  return { target: 'topic', topic: slug, version: topicVersion(body), status: parseTopic(body).status, characters: body.length, limit: config.topicMaxChars }
}

function validateFields(args: MemoryArgs): void {
  const topic = args.target === 'topic'
  const allowed = topic
    ? args.action === 'list' ? ['target', 'action', 'include_retired']
      : args.action === 'read' ? ['target', 'action', 'topic']
        : args.action === 'add' ? ['target', 'action', 'topic', 'content']
          : args.action === 'replace' ? ['target', 'action', 'topic', 'content', 'expected_version']
            : ['target', 'action', 'topic', 'expected_version', 'superseded_by']
    : args.action === 'add' ? ['target', 'action', 'content']
      : args.action === 'replace' ? ['target', 'action', 'content', 'old_text']
        : ['target', 'action', 'old_text']
  if ((!topic && (args.action === 'list' || args.action === 'read'))
    || Object.keys(args).some(key => !allowed.includes(key))) {
    throw new Error(`memory ${args.target}/${args.action} has unsupported fields or action`)
  }
  if (topic && args.action !== 'list') {
    if (args.topic === undefined) throw new Error(`memory topic ${args.action} requires topic`)
    validateTopicSlug(args.topic)
  }
  if (topic && (args.action === 'replace' || args.action === 'remove') && !args.expected_version) {
    throw new Error(`memory topic ${args.action} requires expected_version from read`)
  }
}

/** Longest entry excerpt shown in an approval reason. */
const REASON_EXCERPT_CHARS = 120

function excerpt(text: string): string {
  return text.length <= REASON_EXCERPT_CHARS ? text : `${text.slice(0, REASON_EXCERPT_CHARS)}…`
}

/** Ask the approval service; any outcome other than `allowed-once` refuses the write. */
async function approvedForWrite(
  ctx: Context,
  exec: ToolExecution,
  fileName: string,
  args: MemoryArgs,
): Promise<void> {
  /* v8 ignore start -- applyOperation has already required old_text for replace and remove; the empty arm cannot be reached. */
  const detail = args.content === undefined
    ? args.target === 'topic' ? `${args.action} topic "${args.topic}"` : `${args.action} entry matching "${excerpt(args.old_text ?? '')}"`
    : `${args.action} ${args.target === 'topic' ? `topic "${args.topic}"` : 'entry'} "${excerpt(args.content)}"`
  /* v8 ignore stop */
  if (exec.agent === undefined) {
    throw new Error(`memory write needs approval (${detail}), but this call has no Agent-backed session`)
  }
  const approval = ctx.get('approval')
  if (approval === undefined) {
    throw new Error(
      `memory write needs approval (${detail}); no approval answerer is mounted, so the write was refused`,
    )
  }
  const outcome = await approval.request({
    agent: exec.agent,
    toolName: 'memory',
    callId: exec.callId,
    reason: `Write to ${fileName}: ${detail}`,
    signal: exec.signal,
  })
  if (outcome !== 'allowed-once') {
    throw new Error(`memory write was not approved (${outcome}); the file is unchanged`)
  }
}

/**
 * Build the `memory` tool definition for one resolved configuration over the supplied filesystem.
 * @param ctx - context carrying the approval service read at call time.
 * @param config - complete plugin configuration with the home directory already resolved.
 * @param fs - filesystem service owning reads, writes, and version checks.
 * @returns the tool definition to register on `ctx.tools`.
 */
export function createMemoryTool(
  ctx: Context,
  config: MemoryToolConfig,
  fs: FileSystem,
): ToolDefinition {
  return defineTool({
    name: 'memory',
    description:
      'Edit a curated core memory file or list and read on-demand topic memory. '
      + 'target "user" edits USER.md (who the user is: name, role, environment, standing preferences); '
      + 'target "memory" edits MEMORY.md (your notes: conventions with no task home, environment facts, '
      + 'things learned that apply to every session). Entries are single-line declarative facts, one per '
      + 'call action; the result reports remaining budget. Writes take effect for later sessions; the '
      + 'current session keeps its loaded baseline. Topic files under memories/ are never in the baseline; '
      + 'read them only when relevant. Topic writes use complete Markdown documents with updated, status, source '
      + 'frontmatter and Rule, Why, History sections; replace/remove require the version returned by read. '
      + 'Remove retires a topic instead of deleting it.',
    parameters: {
      target: {
        type: 'string',
        required: true,
        enum: ['user', 'memory', 'topic'],
        description: 'Core file to edit, or the on-demand topic tier.',
      },
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'read', 'add', 'replace', 'remove'],
        description: 'Core files support add/replace/remove; topics also support list/read.',
      },
      content: {
        type: 'string',
        description: 'New entry text for add or replace: one line, no headings, fences, or newlines.',
      },
      old_text: {
        type: 'string',
        description: 'Substring matching exactly one existing entry, for replace or remove.',
      },
      topic: { type: 'string', description: 'Lowercase kebab slug for one topic; omit for list.' },
      expected_version: { type: 'string', description: 'Version returned by topic read; required for replace/remove.' },
      include_retired: { type: 'boolean', description: 'For topic list, include retired files.' },
      superseded_by: { type: 'string', description: 'For topic remove, optional successor slug.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', required: true, enum: ['user', 'memory', 'topic'] },
          entries: { type: 'integer' },
          characters: { type: 'integer' },
          limit: { type: 'integer' },
          topic: { type: 'string' },
          version: { type: 'string' },
          body: { type: 'string' },
          status: { type: 'string' },
          topics: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
            slug: { type: 'string', required: true }, status: { type: 'string', required: true }, updated: { type: 'string', required: true },
          } } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.target === 'topic'
        ? JSON.stringify(value)
        : `${MEMORY_FILE_NAMES[value.target]} now holds ${String(value.entries)} `
          + `entr${value.entries === 1 ? 'y' : 'ies'} (${String(value.characters)} of `
          + `${String(value.limit)} characters).` }],
    },
    async execute(args: MemoryArgs, exec): Promise<MemoryResult> {
      validateFields(args)
      if (args.target === 'topic') return executeTopic(ctx, config, fs, args, exec)
      const fileName = MEMORY_FILE_NAMES[args.target]
      const limit = args.target === 'user' ? config.userMaxChars : config.memoryMaxChars
      const rootPath = config.dshHome
      const filePath = join(rootPath, fileName)
      const filePathInfo = await fs.lstat(filePath, undefined, exec.signal)
      if (filePathInfo?.type === 'symlink') {
        throw new Error(`${fileName} is a symbolic link and cannot be edited by the memory tool`)
      }
      const target = await fs.resolve(filePath, { signal: exec.signal })

      const existing = await fs.stat(target, exec.signal)
      const currentText = existing === undefined ? '' : await fs.readText(target, exec.signal)
      const entries = parseEntries(currentText, fileName)
      let nextEntries: string[]
      let serialized: string
      try {
        nextEntries = applyOperation(entries, {
          action: args.action as MemoryOperation['action'],
          ...args.content === undefined ? {} : { content: args.content },
          ...args.old_text === undefined ? {} : { old_text: args.old_text },
        }, config.entryMaxChars)
        serialized = serializeEntries(nextEntries)
        assertWithinCap(serialized, limit, fileName)
      } catch (error: unknown) {
        if (error instanceof Error && /cap|matches|no entry/.test(error.message)) {
          throw new Error(`${error.message} Current entries (${String(Math.max(0, limit - currentText.length))} characters remain): ${JSON.stringify(entries)}`)
        }
        throw error
      }

      if (config.requireApproval) await approvedForWrite(ctx, exec, fileName, args)

      // Carry THIS session's policy on the write. Omitting it makes the sandboxed
      // filesystem fall back to the deployment default (its mode plus the fallback
      // workspace root) instead of the session's own mode and cwd, so a session
      // holding full access was still refused here.
      const policyService: SandboxPolicyService | undefined = ctx.get('sandboxPolicy')
      const sandboxPolicy = policyService?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
      const allowance = config.allowApprovedHomeWrites && sandboxPolicy?.mode === 'workspace-write'
        ? policyService?.approveFsMutation(sandboxPolicy, config.dshHome, filePath)
        : undefined

      await writeObservedText(ctx, fs, target, serialized, existing, exec, exec.signal, sandboxPolicy, allowance)
      return {
        target: args.target,
        entries: nextEntries.length,
        characters: serialized.length,
        limit,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `memory ${args.action} (${args.target})`,
      kind: args.action === 'remove' ? 'delete' : 'execute',
      rawInput: args.content ?? args.old_text,
    }),
  })
}
