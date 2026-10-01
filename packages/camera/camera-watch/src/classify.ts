/**
 * One logged classification: a root Session with no preset, no tools, and a dedicated complete
 * system prompt receives the instruction and the frames as one `user/message`, and its settled
 * assistant text is the verdict answer. When the caller's check rejects that answer, the same
 * Session receives one corrective `user/message`, and the caller chooses between the two answers.
 * @module @deepseek-ai/dsh-camera-watch/classify
 */

import type { Context } from '@deepseek-ai/cordis'
import { installDedicatedPrompt, type ModelSelection } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSourceMap, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import { awaitTurn, lastAssistantText, lastTurnEndReason } from '@deepseek-ai/dsh-unattended-session'

/** One classification request. */
export interface ClassifyRequest {
  readonly sessionId: SessionId
  /** Complete system prompt; every other prompt section and runtime context is left out. */
  readonly systemPrompt: string
  readonly prompt: string
  readonly frames: readonly ImageAttachmentRef[]
  readonly source: MessageSourceMap['camera']
  readonly selection: ModelSelection
  readonly maxOutputTokens: number
  /** Sampling temperature of every request; the logged request header carries it. */
  readonly temperature: number
  /** Longest wait for each turn, the corrective turn included. */
  readonly timeoutMs: number
  /** One corrective turn for an answer the check rejects; absent accepts the first answer. */
  readonly retry?: ClassifyRetry | undefined
  readonly cwd?: string | undefined
  readonly signal: AbortSignal
}

/** The corrective turn of one classification. */
export interface ClassifyRetry {
  /** Text of the corrective `user/message`. */
  readonly message: string
  /**
   * Whether an answer calls for the corrective turn.
   * @param text - the first turn's trimmed, non-empty answer text.
   * @returns true to send {@link ClassifyRetry.message} and report its turn as `corrective`.
   */
  readonly needed: (text: string) => boolean
}

/** Stable failure codes of one classification turn. */
export type ClassifyFailureCode = 'TIMEOUT' | 'TURN_FAILED' | 'NO_ANSWER' | 'NOT_PERSISTED'

/** One turn's settled answer text, or its stable failure code. */
export type ClassifyTurn =
  | { readonly kind: 'answered'; readonly text: string }
  | { readonly kind: 'failed'; readonly code: ClassifyFailureCode }

/**
 * Classification result: the first turn's answer text with the corrective turn's own result when it
 * ran, or the first turn's failure code.
 */
export type ClassifyOutcome =
  | { readonly kind: 'answered'; readonly text: string; readonly corrective?: ClassifyTurn }
  | { readonly kind: 'failed'; readonly code: ClassifyFailureCode }

/**
 * Run one classification turn, and the corrective turn when `retry` asks for it, then release the
 * Agent. The Session stays in the log. Its Agent scope shadows the deployment persona with
 * `systemPrompt` as the complete prompt, suppresses runtime context, drops every tool schema from
 * prompt assembly (including tools other plugins register in the Agent's own scope after creation),
 * denies every tool execution, and sets `temperature` on every request. Each turn may make exactly one
 * model request, so a classification makes at most two; a second request inside one turn fails that
 * turn. A corrective turn is reported beside the first answer, whether it answered or failed.
 * @param ctx - watch context that owns the Agent.
 * @param request - prompt, frames, attribution, route, and bounds.
 * @returns the settled answer text or a failure code.
 */
export async function classifyFrames(ctx: Context, request: ClassifyRequest): Promise<ClassifyOutcome> {
  const { sessionId } = request
  let requests = 0
  let prompts = 0
  const handle = await ctx.agents.create({
    sessionId,
    signal: request.signal,
    ...request.cwd === undefined ? {} : { meta: { cwd: request.cwd } },
    agentOptions: { ...request.selection, maxTokens: request.maxOutputTokens },
    setup: (agentCtx) => {
      installDedicatedPrompt(agentCtx, { systemPrompt: request.systemPrompt, temperature: request.temperature })
      agentCtx.tools.guard(() => 'camera classification runs without tools')
      agentCtx.on('llm/stream', (options, next) => {
        if (options.sessionId === sessionId && ++requests > prompts) throw new Error('camera classification allows one model request per turn')
        return next()
      })
    },
  })
  try {
    const agent = handle.agent
    const turn = async (content: UserMessage['content']): Promise<ClassifyTurn> => {
      const firstSeq = agent.session.seq
      prompts++
      agent.followup(createUserMessage({ content, source: request.source }))
      const settled = await awaitTurn(agent, { timeoutMs: request.timeoutMs, signal: request.signal })
      if (settled === 'timeout') return { kind: 'failed', code: 'TIMEOUT' }
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const events = agent.session.ownEvents()
      if (lastTurnEndReason(events, firstSeq)?.kind !== 'completed') return { kind: 'failed', code: 'TURN_FAILED' }
      if (!await ctx.sessions.flush(agent.session)) return { kind: 'failed', code: 'NOT_PERSISTED' }
      const text = lastAssistantText(events, firstSeq).trim()
      return text === '' ? { kind: 'failed', code: 'NO_ANSWER' } : { kind: 'answered', text }
    }
    const first = await turn([
      { type: 'text', text: request.prompt },
      ...request.frames.map(attachment => ({ type: 'image' as const, attachment })),
    ])
    if (first.kind === 'failed') return first
    if (request.retry === undefined || !request.retry.needed(first.text)) return first
    return { ...first, corrective: await turn([{ type: 'text', text: request.retry.message }]) }
  } finally {
    await handle.dispose()
  }
}
