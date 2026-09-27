/** One-turn persisted research stages with bounded model admission. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ResearchRunId } from '@deepseek-ai/dsh-research/types'
import type { ResolvedConfig } from './config.ts'
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

/**
 * Run a single logged model turn without exposing any registered tool.
 * @param ctx - provider context that owns the child Agent.
 * @param admission - shared bounded model gate.
 * @param config - exact route, effort and stage timeout.
 * @param runId - parent research Session identity.
 * @param prompt - exact versioned user input.
 * @param maxTokens - stage output ceiling.
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
  prompt: string,
  maxTokens: number,
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
    let response: SessionEvent<'assistant/message'> | undefined
    const handle = await ctx.agents.create({
      sessionId: id,
      meta: { parentSession: SessionId(runId), ...(cwd === undefined ? {} : { cwd }) },
      signal: stageSignal,
      agentOptions: {
        provider: config.provider,
        model: config.model,
        maxTokens,
        ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(config.reasoningEffort) }),
      },
      setup: (agentCtx) => {
        agentCtx.tools.presentAs('native')
        agentCtx.tools.restrict({ allow: [] })
        agentCtx.tools.guard(() => 'research stages cannot execute tools')
        agentCtx.on('session/event', (session, event) => {
          if (session.id === id && event.type === 'assistant/message') response = event
        })
        agentCtx.on('llm/stream', (request, next) => {
          if (request.sessionId !== id) return next()
          if (++modelCalls > 1) throw new Error('research stage attempted another model call')
          if (request.tools !== undefined && request.tools.length > 0) {
            throw new Error(`research stage exposed model tools: ${request.tools.map(tool => tool.name).join(', ')}`)
          }
          return next()
        })
      },
    })
    const abort = () => { handle.agent.cancel({ kind: 'parent' }) }
    stageSignal.addEventListener('abort', abort, { once: true })
    try {
      await linked(id)
      stageSignal.throwIfAborted()
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      stageSignal.throwIfAborted()
      if (!await ctx.sessions.flush(handle.agent.session)) throw new Error('research stage has no durability provider')
      return { id, text: responseText(response) }
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
