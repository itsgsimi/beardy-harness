/**
 * Model-facing `memory` tool: one narrow editor for the two curated memory files under the Harness
 * home. The filesystem service owns mutation and sandbox semantics; this module owns target
 * restriction, the document rules from {@link @deepseek-ai/dsh-tool-memory/store}, and the approval gate.
 * @module @deepseek-ai/dsh-tool-memory/tool
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-user-approval'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  applyOperation,
  assertWithinCap,
  MEMORY_FILE_NAMES,
  parseEntries,
  serializeEntries,
} from './store.ts'
import type { MemoryTarget } from './store.ts'

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
  /** Route every write through the approval service before touching the file. */
  readonly requireApproval: boolean
}

interface MemoryArgs {
  target: MemoryTarget
  action: 'add' | 'replace' | 'remove'
  content?: string
  old_text?: string
}

interface MemoryResult {
  target: MemoryTarget
  entries: number
  characters: number
  limit: number
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
    ? `${args.action} entry matching "${excerpt(args.old_text ?? '')}"`
    : `${args.action} entry "${excerpt(args.content)}"`
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
) {
  return defineTool({
    name: 'memory',
    description:
      'Edit one of the two curated memory files that load into every future session\'s baseline. '
      + 'target "user" edits USER.md (who the user is: name, role, environment, standing preferences); '
      + 'target "memory" edits MEMORY.md (your notes: conventions with no task home, environment facts, '
      + 'things learned that apply to every session). Entries are single-line declarative facts, one per '
      + 'call action; the result reports remaining budget. Writes take effect for later sessions; the '
      + 'current session keeps its loaded baseline.',
    parameters: {
      target: {
        type: 'string',
        required: true,
        enum: ['user', 'memory'],
        description: 'Which memory file to edit.',
      },
      action: {
        type: 'string',
        required: true,
        enum: ['add', 'replace', 'remove'],
        description: 'Operation to perform on one entry.',
      },
      content: {
        type: 'string',
        description: 'New entry text for add or replace: one line, no headings, fences, or newlines.',
      },
      old_text: {
        type: 'string',
        description: 'Substring matching exactly one existing entry, for replace or remove.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', required: true, enum: ['user', 'memory'] },
          entries: { type: 'integer', required: true },
          characters: { type: 'integer', required: true },
          limit: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${MEMORY_FILE_NAMES[value.target]} now holds ${String(value.entries)} `
          + `entr${value.entries === 1 ? 'y' : 'ies'} (${String(value.characters)} of `
          + `${String(value.limit)} characters).`,
      }],
    },
    async execute(args: MemoryArgs, exec): Promise<MemoryResult> {
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
      const nextEntries = applyOperation(entries, args, config.entryMaxChars)
      const serialized = serializeEntries(nextEntries)
      assertWithinCap(serialized, limit, fileName)

      if (config.requireApproval) await approvedForWrite(ctx, exec, fileName, args)

      const expected = existing === undefined
        ? { kind: 'createIfAbsent' as const }
        : { kind: 'replaceIfVersion' as const, version: existing.version }
      ctx.emit('fs/observed', target, existing === undefined
        ? { kind: 'absent' }
        : { kind: 'present', version: existing.version }, exec)
      const outcome = await fs.writeText(target, serialized, expected, exec.signal)
      ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
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
