/**
 * Curated memory plugin: the model-facing `memory` tool over `$DSH_HOME/USER.md` and
 * `$DSH_HOME/MEMORY.md`, plus the prompt guidance that keeps writes declarative and inside the caps.
 * The files themselves enter future sessions through `dsh-agent-instructions` user-global candidates;
 * this plugin owns editing them, not delivering them.
 * @module @deepseek-ai/dsh-tool-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-user-approval'
import { createMemoryTool } from './tool.ts'
import type { MemoryToolConfig } from './tool.ts'

export * from './store.ts'
export * from './topic.ts'
export * from './tool.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tool-memory'

/** Services the plugin registers its tool and guidance on; `fs` is awaited through a nested inject. */
export const inject = ['tools', 'systemPrompt']

/**
 * Prompt order of the `tool:memory` section: after the session-query tool guidance (2300) and before
 * the goal tool guidance (2400) in the System Prompt service's named section allocation.
 */
export const MEMORY_SECTION_ORDER = 2350

/** Default character cap for USER.md, sized to stay far under the instruction-file byte budget. */
export const DEFAULT_USER_MAX_CHARS = 1375

/** Default character cap for MEMORY.md. */
export const DEFAULT_MEMORY_MAX_CHARS = 2200

/** Default character cap for one memory entry. */
export const DEFAULT_ENTRY_MAX_CHARS = 400
/** Default complete topic file cap. */
export const DEFAULT_TOPIC_MAX_CHARS = 16384
/** Default number of topic files, including retired topics. */
export const DEFAULT_TOPIC_MAX_FILES = 64

/** Plugin configuration; every tunable is a validated field changeable from cordis.yml. */
export interface Config {
  /** Harness home holding the two files. Defaults to `$DSH_HOME` or `~/.dsh`. */
  readonly dshHome?: string
  /** Character cap for USER.md. Defaults to 1375. */
  readonly userMaxChars?: number
  /** Character cap for MEMORY.md. Defaults to 2200. */
  readonly memoryMaxChars?: number
  /** Character cap for one entry. Defaults to 400. */
  readonly entryMaxChars?: number
  /** Complete topic document cap in characters. */
  readonly topicMaxChars?: number
  /** Maximum number of topic files, including retired topics. */
  readonly topicMaxFiles?: number
  /** Maximum topic document returned by read. */
  readonly topicReadMaxChars?: number
  /** Ask the approval service before every write. Defaults to false; set true for unattended presets. */
  readonly requireApproval?: boolean
  /** Permit one exact Harness-home mutation after approval in workspace-write mode. */
  readonly allowApprovedHomeWrites?: boolean
}

export const Config: z<Config> = z.object({
  dshHome: z.string(),
  userMaxChars: z.number().step(1).min(1).default(DEFAULT_USER_MAX_CHARS),
  memoryMaxChars: z.number().step(1).min(1).default(DEFAULT_MEMORY_MAX_CHARS),
  entryMaxChars: z.number().step(1).min(1).default(DEFAULT_ENTRY_MAX_CHARS),
  topicMaxChars: z.number().step(1).min(1).default(DEFAULT_TOPIC_MAX_CHARS),
  topicMaxFiles: z.number().step(1).min(1).default(DEFAULT_TOPIC_MAX_FILES),
  topicReadMaxChars: z.number().step(1).min(1).default(DEFAULT_TOPIC_MAX_CHARS),
  requireApproval: z.boolean().default(false),
  allowApprovedHomeWrites: z.boolean().default(false),
})

/** Complete configuration after schemastery applies every field default and the home is resolved. */
export type ResolvedConfig = MemoryToolConfig

/** Reject caps that cannot hold one entry; the home path is normalized absolute by {@link resolveDshHome}. */
function assertConfig(config: ResolvedConfig): void {
  if (config.allowApprovedHomeWrites && !config.requireApproval) {
    throw new Error('tool-memory: allowApprovedHomeWrites requires requireApproval')
  }
  if (config.entryMaxChars > config.userMaxChars || config.entryMaxChars > config.memoryMaxChars) {
    throw new Error(
      'tool-memory: entryMaxChars must fit inside both file caps; a single entry could never be stored',
    )
  }
  if (config.topicReadMaxChars > config.topicMaxChars) {
    throw new Error('tool-memory: topicReadMaxChars must be no greater than topicMaxChars')
  }
}

const PROMPT_TEXT =
  'Two curated memory files load into every future session\'s baseline: USER.md holds who the user is '
  + '(name, role, environment, standing preferences); MEMORY.md holds your notes — conventions with no '
  + 'task home, environment facts, things learned that apply to every session. Write declarative facts, '
  + 'not instructions ("User prefers concise replies", not "Always be concise"). Procedures belong in '
  + 'skills and task state belongs in the workspace; memory is the narrow exception for cross-session '
  + 'facts. The caps are small: when a fact does not fit, use action replace to merge or retire an '
  + 'existing entry instead of skipping the write. A fact likely to go stale within a week belongs in '
  + 'session history, not memory. Writes apply to later sessions; the current session keeps its loaded '
  + 'baseline.'

/**
 * Register the `memory` tool and its model guidance. The tool waits for the filesystem service
 * through a nested inject, so mounting this plugin never forces an fs provider into the composition.
 * @param ctx - registrant context carrying the tool registry and prompt-section service.
 * @param config - deployment's caps, home override, and approval stance.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = {
    dshHome: resolveDshHome(config.dshHome),
    userMaxChars: config.userMaxChars,
    memoryMaxChars: config.memoryMaxChars,
    entryMaxChars: config.entryMaxChars,
    topicMaxChars: config.topicMaxChars,
    topicMaxFiles: config.topicMaxFiles,
    topicReadMaxChars: config.topicReadMaxChars,
    requireApproval: config.requireApproval,
    allowApprovedHomeWrites: config.allowApprovedHomeWrites,
  } as ResolvedConfig
  assertConfig(resolved)
  ctx.systemPrompt.section({
    name: 'tool:memory',
    order: MEMORY_SECTION_ORDER,
    text: PROMPT_TEXT,
  })
  ctx.inject(['fs'], (fsCtx) => {
    fsCtx.tools.register(createMemoryTool(ctx, resolved, fsCtx.fs))
  })
}
