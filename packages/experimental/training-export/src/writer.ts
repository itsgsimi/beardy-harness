/**
 * Per-session mutable tracking and the off-hot-path append queue: turn/step
 * position, the open turn's running counts, and the `samples.jsonl` /
 * `labels.jsonl` / `meta.json` writers. Every write goes through one
 * per-session promise chain (`fs.appendFile`), and every failure is logged
 * and swallowed here — nothing from this module ever reaches the agent loop.
 * @module @deepseek-ai/dsh-experimental-training-export/writer
 */

import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { errorChain, type GenerateOptions, type MessageId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionEventMap, SessionId } from '@deepseek-ai/dsh-session'
// Type-only: brings `hook/result`, `approval/asked`/`approval/decided`, and
// `compaction/start`/`compaction/end` into the merge-extensible
// `SessionEventMap` this module switches on. Each service stays optional at
// runtime (`ctx.get(...)`); see the message-feedback import below.
import type {} from '@deepseek-ai/dsh-hook-protocol'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-message-feedback'
import { labelsPath, metaPath, samplesPath, sessionDir } from './paths.ts'
import { hashSystem, hashTools } from './hash.ts'
import { captureWorkspaceHead, diffTreeSnapshot } from './workspace.ts'
import type {
  TrainingApprovalCounts, TrainingExportMeta, TrainingHookOutcome, TrainingLabelLine,
  TrainingRatingEntry, TrainingSampleRequest, TrainingSampleResponse, TrainingWorkspaceSnapshot,
} from './types.ts'

/** Resolved, validated plugin configuration (see `Config` in `index.ts`). */
export interface ResolvedConfig {
  readonly root: string
  readonly providers: readonly string[]
}

/** One open turn's running aggregate; closed and handed to the label writer at `turn/end`. */
interface TurnAggregate {
  readonly turn: number
  readonly sampleSeqs: number[]
  steps: number
  toolCalls: number
  toolErrors: number
  readonly hooks: TrainingHookOutcome[]
  approvalsAsked: number
  approvalsApproved: number
  approvalsRejected: number
  compactionInTurn: boolean
  readonly assistantMessageIds: MessageId[]
  workspaceCaptured: boolean
  workspace: TrainingWorkspaceSnapshot | null
  /** Tree hash from `captureWorkspaceHead`, kept only to diff against at `turn/end`; never serialized. */
  workspaceTree: string | null
}

/** Per-session mutable state this plugin owns; garbage-collected with the `Session`. */
export interface SessionExportState {
  readonly dir: string
  /** Off-hot-path append-queue tail; every enqueued task swallows its own failure. */
  queue: Promise<void>
  /** Undefined until first resolved, by counting existing `samples.jsonl` lines. */
  nextSeq: number | undefined
  metaWritten: boolean
  turn: number | null
  step: number | null
  turnAgg: TurnAggregate | null
}

/** Create fresh per-session state. */
function createState(config: ResolvedConfig, session: Session): SessionExportState {
  return {
    dir: sessionDir(config.root, session.id),
    queue: Promise.resolve(),
    nextSeq: undefined,
    metaWritten: false,
    turn: null,
    step: null,
    turnAgg: null,
  }
}

/**
 * Lazily create and cache one session's export state.
 * @param sessions - the plugin fiber's own `Session` → state map.
 * @param config - resolved plugin configuration.
 * @param session - the live session to resolve state for.
 * @returns the session's existing or newly created export state.
 */
export function ensureState(
  sessions: WeakMap<Session, SessionExportState>, config: ResolvedConfig, session: Session,
): SessionExportState {
  let state = sessions.get(session)
  if (state === undefined) {
    state = createState(config, session)
    sessions.set(session, state)
  }
  return state
}

/** Queue one write task behind this session's prior writes; failures are logged, never thrown onward. */
function enqueue(ctx: Context, state: SessionExportState, sessionId: SessionId, task: () => Promise<void>): void {
  state.queue = state.queue.then(task).catch((error: unknown) => {
    ctx.logger.warn(`training-export: session "${String(sessionId)}" write failed: ${errorChain(error)}`)
  })
}

/** Count existing complete lines, so a resumed session continues its `seq` counter instead of restarting it. */
async function countExistingLines(path: string): Promise<number> {
  try {
    const text = await readFile(path, 'utf8')
    return text.length === 0 ? 0 : text.split('\n').filter(line => line.length > 0).length
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

const { version: sessionPackageVersion } = createRequire(import.meta.url)('@deepseek-ai/dsh-session/package.json') as { version: string }
const { version: pluginVersion } = createRequire(import.meta.url)('../package.json') as { version: string }
/** `dsh-<dsh-session's own package version>`, the harness identity recorded in `meta.json`. */
const HARNESS_VERSION = `dsh-${sessionPackageVersion}`
/** This plugin's own `<npm name>/<version>` identity recorded in `meta.json`. */
const PLUGIN_VERSION = `dsh-experimental-training-export/${pluginVersion}`

/** Write `meta.json` once; a second writer (this process or a resumed one) leaves the existing file untouched. */
async function writeMetaOnce(dir: string, session: Session): Promise<void> {
  const header = session.header
  const meta: TrainingExportMeta = {
    version: 1,
    sessionId: session.id,
    parentSessionId: header.parentSession ?? null,
    delegationDepth: header.delegationDepth ?? 0,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    createdAt: header.createdAt,
    harness: HARNESS_VERSION,
    plugin: PLUGIN_VERSION,
  }
  try {
    await writeFile(metaPath(dir), JSON.stringify(meta), { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/**
 * Resolve this sample's workspace snapshot: reuse the turn's already-captured
 * value, capture it now (first allow-listed-provider sample this turn), or
 * `null` (no open turn, no session `cwd`, or a non-matching provider that has
 * not yet been superseded by a matching one this turn).
 */
async function resolveWorkspace(
  config: ResolvedConfig, session: Session, agg: TurnAggregate | null, provider: string,
): Promise<TrainingWorkspaceSnapshot | null> {
  if (agg === null) return null
  if (agg.workspaceCaptured) return agg.workspace
  const cwd = session.header.cwd
  if (cwd === undefined) {
    agg.workspaceCaptured = true
    agg.workspace = null
    agg.workspaceTree = null
    return null
  }
  if (!config.providers.includes(provider)) return null
  agg.workspaceCaptured = true
  const { head, dirty, tree } = await captureWorkspaceHead(cwd)
  agg.workspace = { cwd, head, dirty }
  agg.workspaceTree = tree
  return agg.workspace
}

/** Build the spec's `request` field: `GenerateOptions` minus `signal`/`sessionId`, `purpose` defaulted to `null`. */
function toSampleRequest(options: GenerateOptions): TrainingSampleRequest {
  const { signal: _signal, sessionId: _sessionId, purpose, ...rest } = options
  return { ...rest, purpose: purpose ?? null }
}

/** Everything the `llm/stream` wrapper folded from the downstream stream, ready to serialize. */
export interface FoldedSample {
  readonly turn: number | null
  readonly step: number | null
  readonly options: GenerateOptions
  readonly response: TrainingSampleResponse
}

/**
 * Enqueue one `train/sample` line. Off the hot path: called from the
 * `llm/stream` wrapper's `finally`, never awaited there.
 * @param ctx - plugin context (for logging).
 * @param config - resolved plugin configuration.
 * @param session - the live session the call belongs to.
 * @param state - the session's export state.
 * @param turnAgg - the turn aggregate open when the call started (or `null` outside a turn).
 * @param folded - the folded stream outcome to serialize.
 */
export function enqueueSample(
  ctx: Context, config: ResolvedConfig, session: Session, state: SessionExportState,
  turnAgg: TurnAggregate | null, folded: FoldedSample,
): void {
  enqueue(ctx, state, session.id, async () => {
    await mkdir(state.dir, { recursive: true })
    if (!state.metaWritten) {
      state.metaWritten = true
      await writeMetaOnce(state.dir, session)
    }
    const workspace = await resolveWorkspace(config, session, turnAgg, folded.options.provider)
    if (state.nextSeq === undefined) state.nextSeq = await countExistingLines(samplesPath(state.dir))
    const seq = state.nextSeq
    state.nextSeq = seq + 1
    if (turnAgg !== null) turnAgg.sampleSeqs.push(seq)
    const line = {
      version: 1 as const,
      kind: 'sample' as const,
      seq,
      turn: folded.turn,
      step: folded.step,
      purpose: folded.options.purpose ?? null,
      at: Date.now(),
      request: toSampleRequest(folded.options),
      response: folded.response,
      hashes: { system: hashSystem(folded.options.system), tools: hashTools(folded.options.tools) },
      workspace,
    }
    await appendFile(samplesPath(state.dir), `${JSON.stringify(line)}\n`, 'utf8')
  })
}

/** Read this turn's ratings for its assistant messages, or `[]` when the feedback service is not mounted. */
async function resolveRatings(
  ctx: Context, sessionId: SessionId, assistantMessageIds: readonly MessageId[],
): Promise<TrainingRatingEntry[]> {
  const feedback = ctx.get('messageFeedback')
  if (feedback === undefined || assistantMessageIds.length === 0) return []
  const result = await feedback.list({ sessionId })
  if (!result.ok) return []
  const wanted = new Set<string>(assistantMessageIds)
  return result.value.items
    .filter(item => wanted.has(item.messageId))
    .map(item => ({ messageId: item.messageId, rating: item.rating, note: item.note ?? '' }))
}

/**
 * Enqueue one `train/label` line at `turn/end`.
 * @param ctx - plugin context (for logging and the optional feedback service).
 * @param session - the live session whose turn ended.
 * @param state - the session's export state.
 * @param agg - the closed turn's aggregate.
 * @param reason - the session log's `turn/end` payload.
 */
export function enqueueLabel(
  ctx: Context, session: Session, state: SessionExportState,
  agg: TurnAggregate, reason: SessionEventMap['turn/end'],
): void {
  enqueue(ctx, state, session.id, async () => {
    await mkdir(state.dir, { recursive: true })
    const diff = agg.workspace !== null && agg.workspaceTree !== null
      ? await diffTreeSnapshot(agg.workspace.cwd, agg.workspaceTree)
      : null
    const ratings = await resolveRatings(ctx, session.id, agg.assistantMessageIds)
    const approvals: TrainingApprovalCounts = {
      asked: agg.approvalsAsked, approved: agg.approvalsApproved, rejected: agg.approvalsRejected,
    }
    const label: TrainingLabelLine = {
      version: 1,
      kind: 'label',
      turn: reason.turn,
      at: Date.now(),
      completed: reason.reason.kind === 'completed',
      finishReason: reason.reason.kind,
      steps: agg.steps,
      samples: [...agg.sampleSeqs].sort((a, b) => a - b),
      toolCalls: agg.toolCalls,
      toolErrors: agg.toolErrors,
      hooks: agg.hooks,
      approvals,
      diff,
      ratings,
      compactionInTurn: agg.compactionInTurn,
    }
    await appendFile(labelsPath(state.dir), `${JSON.stringify(label)}\n`, 'utf8')
  })
}

/** Start tracking a new open turn; replaces any (unexpected) still-open aggregate. */
function startTurn(state: SessionExportState, turn: number): void {
  state.turn = turn
  state.step = null
  state.turnAgg = {
    turn,
    sampleSeqs: [],
    steps: 0,
    toolCalls: 0,
    toolErrors: 0,
    hooks: [],
    approvalsAsked: 0,
    approvalsApproved: 0,
    approvalsRejected: 0,
    compactionInTurn: false,
    assistantMessageIds: [],
    workspaceCaptured: false,
    workspace: null,
    workspaceTree: null,
  }
}

/**
 * Fold one session-log event into turn/step tracking and the open turn's
 * running aggregate, enqueueing the `train/label` line at `turn/end`.
 * Called from the `session/event` firehose; every branch is synchronous
 * bookkeeping except the label write, which is enqueued (never awaited here).
 * @param ctx - plugin context (for logging and the optional feedback service).
 * @param session - the live session the event belongs to.
 * @param state - the session's export state.
 * @param event - the just-appended session-log event.
 */
export function trackSessionEvent(
  ctx: Context, session: Session, state: SessionExportState, event: SessionEvent,
): void {
  switch (event.type) {
    case 'turn/start':
      startTurn(state, event.data.turn)
      break
    case 'turn/end': {
      const agg = state.turnAgg
      state.turn = null
      state.step = null
      state.turnAgg = null
      if (agg !== null) enqueueLabel(ctx, session, state, agg, event.data)
      break
    }
    case 'step/start':
      state.step = event.data.step
      if (state.turnAgg !== null) state.turnAgg.steps += 1
      break
    case 'step/end':
      state.step = null
      break
    case 'tool/call':
      if (state.turnAgg !== null) state.turnAgg.toolCalls += 1
      break
    case 'tool/result':
      if (state.turnAgg !== null && event.data.message.content[0].isError === true) {
        state.turnAgg.toolErrors += 1
      }
      break
    case 'assistant/message':
      if (state.turnAgg !== null) state.turnAgg.assistantMessageIds.push(event.data.message.id)
      break
    case 'hook/result':
      if (state.turnAgg !== null) {
        state.turnAgg.hooks.push({
          // `point`/`handlerId` are the only hook/result identity fields; joining
          // them is this writer's own naming choice, not a literal source field.
          name: `${event.data.point}:${event.data.handlerId}`,
          ok: event.data.exitCode === 0,
          ...(event.data.exitCode === undefined ? {} : { exitCode: event.data.exitCode }),
        })
      }
      break
    case 'approval/asked':
      if (state.turnAgg !== null) state.turnAgg.approvalsAsked += 1
      break
    case 'approval/decided':
      if (state.turnAgg !== null) {
        if (event.data.outcome === 'allowed-once') state.turnAgg.approvalsApproved += 1
        else state.turnAgg.approvalsRejected += 1
      }
      break
    case 'compaction/start':
    case 'compaction/end':
      if (state.turnAgg !== null && event.data.turn === state.turnAgg.turn) state.turnAgg.compactionInTurn = true
      break
    default:
      // Merge-extensible session-log vocabulary: every event type this
      // writer does not track (including plugin-merged ones it never heard
      // of) passes through untouched.
      break
  }
}
