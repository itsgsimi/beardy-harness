/** Persisted research stage turns with a dedicated system prompt and bounded model admission. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { installDedicatedPrompt, type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ResearchRunId } from '@deepseek-ai/dsh-research/types'
import type { ResolvedConfig } from './config.ts'
import { RESEARCH_JSON_CORRECTION } from './prompts.ts'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-persistence'

interface Waiter {
  resolve: () => void
  reject: (error: unknown) => void
  signal: AbortSignal
  abort: () => void
}

/** Abortable slot gate shared by all model stages of one provider. */
export class StageAdmission {
  private active = 0
  private readonly waiting: Waiter[] = []

  /** @param limit - maximum simultaneous model stages. */
  constructor(private readonly limit: number) {}

  /**
   * Acquire a model slot, including queue wait in the caller's timeout.
   * @param signal - cancellation for queued admission.
   * @returns a single-use slot release callback.
   */
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    if (this.active < this.limit) {
      this.active++
      return () => { this.release() }
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve, reject, signal,
        abort: () => {
          this.waiting.splice(this.waiting.indexOf(waiter), 1)
          reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
        },
      }
      this.waiting.push(waiter)
      signal.addEventListener('abort', waiter.abort, { once: true })
    })
    return () => { this.release() }
  }

  private release(): void {
    const next = this.waiting.shift()
    if (next === undefined) {
      this.active--
      return
    }
    next.signal.removeEventListener('abort', next.abort)
    next.resolve()
  }
}

/** A stage response plus its discoverable child Session ID. */
export interface StageResult {
  readonly id: SessionId
  readonly text: string
}

/** The model-visible input and sampling of one stage. */
export interface StageRequest {
  /** Exact first `user/message` text. */
  readonly prompt: string
  /** Output ceiling of each stage request. */
  readonly maxTokens: number
  /** Complete system prompt of the stage Session. */
  readonly systemPrompt: string
  /** Sampling temperature of each stage request. */
  readonly temperature: number
  /**
   * Whether an answer is the JSON the prompt asks for; absent accepts the first answer.
   * @param text - trimmed, non-empty answer text.
   * @returns false to send {@link RESEARCH_JSON_CORRECTION} as one corrective turn.
   */
  readonly expectJson?: ((text: string) => boolean) | undefined
}

/**
 * Run one logged stage turn without exposing any registered tool, plus one corrective turn in the same
 * Session when `expectJson` rejects the first answer. The stage Session answers from
 * `request.systemPrompt` alone: no deployment persona, runtime context, or tool schema reaches it, and
 * every request carries `request.temperature`. Each turn may make exactly one model request, so a stage
 * makes at most two. A corrective answer replaces the first only when it passes `expectJson`; an
 * unsettled or failing corrective answer leaves the first answer as the result.
 * @param ctx - provider context that owns the child Agent.
 * @param admission - shared bounded model gate.
 * @param config - exact route, effort and stage timeout.
 * @param runId - parent research Session identity.
 * @param parentAgent - live run Agent whose scoped tools remain inherited and restrictable.
 * @param request - exact versioned input, system prompt, sampling, and JSON check.
 * @param signal - run cancellation and hard timeout.
 * @param cwd - caller workspace for authorized explicit stage reads.
 * @param linked - commit the stage ID into the run Session before sending input.
 * @returns settled assistant text and its persisted child ID.
 */
export async function runStage(
  ctx: Context,
  admission: StageAdmission,
  config: ResolvedConfig,
  runId: ResearchRunId,
  parentAgent: Agent,
  request: StageRequest,
  signal: AbortSignal,
  cwd: string | undefined,
  linked: (id: SessionId) => Promise<void>,
): Promise<StageResult> {
  const timeout = new AbortController()
  const timer = setTimeout(() => { timeout.abort(new Error('research stage timeout')) }, config.budgets.stageTimeoutMs)
  const stageSignal = AbortSignal.any([signal, timeout.signal])
  let release: (() => void) | undefined
  try {
    release = await admission.acquire(stageSignal)
    stageSignal.throwIfAborted()
    const id = SessionId(`rs-native-${randomUUID()}`)
    let modelCalls = 0
    let turns = 0
    let response: SessionEvent<'assistant/message'> | undefined
    const handle = await ctx.agents.create({
      sessionId: id,
      parentAgent,
      meta: { parentSession: SessionId(runId), ...(cwd === undefined ? {} : { cwd }) },
      signal: stageSignal,
      agentOptions: {
        provider: config.provider,
        model: config.model,
        maxTokens: request.maxTokens,
        ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(config.reasoningEffort) }),
      },
      setup: (agentCtx) => {
        agentCtx.tools.presentAs('native')
        agentCtx.tools.restrict({ allow: [] })
        agentCtx.tools.guard(() => 'research stages cannot execute tools')
        installDedicatedPrompt(agentCtx, { systemPrompt: request.systemPrompt, temperature: request.temperature })
        agentCtx.on('session/event', (session, event) => {
          if (session.id === id && event.type === 'assistant/message') response = event
        })
        agentCtx.on('llm/stream', (options, next) => {
          if (options.sessionId !== id) return next()
          if (++modelCalls > turns) throw new Error('research stage attempted another model call')
          return next()
        })
      },
    })
    const abort = () => {
      try {
        handle.agent.cancel({ kind: 'parent' })
      } catch {
        // A whole-host shutdown can dispose the stage Agent before the run's abort reaches it; nothing remains to cancel.
      }
    }
    stageSignal.addEventListener('abort', abort, { once: true })
    const turn = async (text: string): Promise<SessionEvent<'assistant/message'> | undefined> => {
      response = undefined
      turns++
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      stageSignal.throwIfAborted()
      if (!await ctx.sessions.flush(handle.agent.session)) throw new Error('research stage has no durability provider')
      return response
    }
    try {
      await linked(id)
      stageSignal.throwIfAborted()
      const first = responseText(await turn(request.prompt))
      if (request.expectJson === undefined || request.expectJson(first)) return { id, text: first }
      const corrective = await turn(RESEARCH_JSON_CORRECTION)
      let second: string
      try {
        second = responseText(corrective)
      } catch {
        // An unsettled or empty corrective answer leaves the first answer as the stage result.
        return { id, text: first }
      }
      return { id, text: request.expectJson(second) ? second : first }
    } finally {
      stageSignal.removeEventListener('abort', abort)
      await handle.dispose()
    }
  } finally {
    clearTimeout(timer)
    release?.()
  }
}

/** Read only a settled, uninterrupted assistant text response. */
function responseText(event: SessionEvent<'assistant/message'> | undefined): string {
  if (event === undefined || event.data.interrupted) throw new Error('research stage had no settled assistant response')
  const text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
  if (!text) throw new Error('research stage returned empty text')
  return text
}
