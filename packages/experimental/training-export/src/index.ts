/**
 * Sidecar training-data capture: folds every `llm/stream` call whose
 * `sessionId` is set into a `train/sample` line, and every `turn/end` into a
 * `train/label` line, beside (never inside) the session log. Contract:
 * `docs/training-export-format.md` in the halorun checkout.
 * @module @deepseek-ai/dsh-experimental-training-export
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock, FinishReason, GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  ensureState, enqueueSample, trackSessionEvent, type ResolvedConfig, type SessionExportState,
} from './writer.ts'
import type { TrainingSampleError, TrainingSampleResponse } from './types.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'training-export'

/** Services this plugin's listeners read; `messageFeedback` stays optional (`ctx.get`). */
export const inject = ['llm', 'sessions']

/** Required, no-hidden-default plugin configuration. */
export interface Config {
  /** Absolute directory for every session's sidecar; created on first write. */
  readonly root: string
  /**
   * Non-empty allow-list matched against `GenerateOptions.provider`. Gates
   * only the per-turn workspace `git` reads: every provider's samples are
   * written regardless, and the `halorun dataset` reader applies its own
   * provider filter.
   */
  readonly providers: string[]
  /** Whether this plugin's listeners are active; no default — an omitted value fails to load, not silently off. */
  readonly enabled: boolean
}

/** Loader schema: every field required, so a missing one fails config validation loudly. */
export const Config: z<Config> = z.object({
  root: z.string().required(),
  providers: z.array(z.string().min(1)).min(1).required(),
  enabled: z.boolean().required(),
})

/** Normalize a downstream-thrown error into the spec's `{name, message, code?}` shape. */
function mapThrownError(thrown: unknown): TrainingSampleError {
  const normalized = thrown instanceof Error ? thrown : new Error(String(thrown))
  const code = (normalized as { code?: unknown }).code
  return {
    name: normalized.name,
    message: normalized.message,
    ...(typeof code === 'string' ? { code } : {}),
  }
}

/** Normalize a terminal `error`/`aborted` finish reason's `LlmFailure` into the spec's error shape. */
function mapFailureReason(reason: Extract<FinishReason, { kind: 'error' | 'aborted' }>): TrainingSampleError {
  return { name: reason.kind === 'aborted' ? 'AbortError' : 'LlmError', message: reason.failure.message, code: reason.failure.code }
}

/**
 * Wrap the downstream `llm/stream` chain: fold its chunks into a response
 * while passing every chunk through unchanged, then enqueue the `train/sample`
 * line once the stream settles (normally, on abort, or on error) — `next()`
 * is called exactly once.
 */
async function* captureSample(
  ctx: Context, config: ResolvedConfig, session: Session, state: SessionExportState,
  options: GenerateOptions, next: () => AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  const turn = state.turn
  const step = state.step
  const turnAgg = state.turnAgg
  const blocks = new Map<number, ContentBlock>()
  let finish: FinishReason | null = null
  let usage: TokenUsage | null = null
  let error: TrainingSampleError | null = null
  try {
    for await (const chunk of next()) {
      switch (chunk.type) {
        case 'block-end':
          blocks.set(chunk.index, chunk.block)
          break
        case 'usage':
          usage = chunk.usage
          break
        case 'finish':
          finish = chunk.reason
          if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') error = mapFailureReason(chunk.reason)
          break
        default:
          break
      }
      yield chunk
    }
  } catch (thrown) {
    error = mapThrownError(thrown)
    throw thrown
  } finally {
    const content = [...blocks.entries()].sort(([left], [right]) => left - right).map(([, block]) => block)
    const response: TrainingSampleResponse = { content, finish, usage, error }
    enqueueSample(ctx, config, session, state, turnAgg, { turn, step, options, response })
  }
}

/**
 * Install the `llm/stream` capture wrapper and the `session/event` tracker.
 * @param ctx - plugin context; requires `ctx.llm` and `ctx.sessions`.
 * @param config - validated, required plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  if (!isAbsolute(config.root)) {
    throw new Error(`training-export: config.root must be an absolute path, got ${JSON.stringify(config.root)}`)
  }
  if (!config.enabled) return

  const resolved: ResolvedConfig = { root: config.root, providers: config.providers }
  const sessions = new WeakMap<Session, SessionExportState>()

  ctx.on('llm/stream', (options, next): AsyncIterable<StreamChunk> => {
    if (options.sessionId === undefined) return next()
    const session = ctx.sessions.get(options.sessionId)
    if (session === undefined) return next()
    const state = ensureState(sessions, resolved, session)
    return captureSample(ctx, resolved, session, state, options, next)
  })

  ctx.on('session/event', (session, event) => {
    const state = ensureState(sessions, resolved, session)
    trackSessionEvent(ctx, session, state, event)
  })
}
