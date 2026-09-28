/**
 * One logged classification turn: a root Session with no preset, no tools, and a dedicated complete
 * system prompt receives the instruction and the frames as one `user/message`, and its settled
 * assistant text is the verdict answer.
 * @module @deepseek-ai/dsh-camera-watch/classify
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSourceMap } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
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
  readonly timeoutMs: number
  readonly cwd?: string | undefined
  readonly signal: AbortSignal
}

/** Classification result: the answer text, or a stable failure code. */
export type ClassifyOutcome =
  | { readonly kind: 'answered'; readonly text: string }
  | { readonly kind: 'failed'; readonly code: 'TIMEOUT' | 'TURN_FAILED' | 'NO_ANSWER' | 'NOT_PERSISTED' }

/**
 * Run one classification turn and release its Agent. The Session stays in the log. Its Agent scope
 * shadows the deployment persona with `systemPrompt` as the complete prompt, suppresses runtime
 * context, drops every tool schema from prompt assembly (including tools other plugins register in
 * the Agent's own scope after creation), and denies every tool execution. The turn may make exactly
 * one model request; a second request fails the turn.
 * @param ctx - watch context that owns the Agent.
 * @param request - prompt, frames, attribution, route, and bounds.
 * @returns the settled answer text or a failure code.
 */
export async function classifyFrames(ctx: Context, request: ClassifyRequest): Promise<ClassifyOutcome> {
  const { sessionId } = request
  let requests = 0
  const handle = await ctx.agents.create({
    sessionId,
    signal: request.signal,
    ...request.cwd === undefined ? {} : { meta: { cwd: request.cwd } },
    agentOptions: { ...request.selection, maxTokens: request.maxOutputTokens },
    setup: (agentCtx) => {
      agentCtx.systemPrompt.section({
        name: PERSONA_PREFIX_SECTION,
        order: agentCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
        text: request.systemPrompt,
        interpolate: false,
        complete: true,
      })
      agentCtx.systemPrompt.suppressRuntimeContext()
      agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => ({ ...await next(), tools: [] }))
      agentCtx.tools.guard(() => 'camera classification runs without tools')
      agentCtx.on('llm/stream', (options, next) => {
        if (options.sessionId === sessionId && ++requests > 1) throw new Error('camera classification allows one model request')
        return next()
      })
    },
  })
  try {
    const agent = handle.agent
    const firstSeq = agent.session.seq
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: request.prompt }, ...request.frames.map(attachment => ({ type: 'image' as const, attachment }))],
      source: request.source,
    }))
    const settled = await awaitTurn(agent, { timeoutMs: request.timeoutMs, signal: request.signal })
    if (settled === 'timeout') return { kind: 'failed', code: 'TIMEOUT' }
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const events = agent.session.ownEvents()
    if (lastTurnEndReason(events, firstSeq)?.kind !== 'completed') return { kind: 'failed', code: 'TURN_FAILED' }
    if (!await ctx.sessions.flush(agent.session)) return { kind: 'failed', code: 'NOT_PERSISTED' }
    const text = lastAssistantText(events, firstSeq).trim()
    return text === '' ? { kind: 'failed', code: 'NO_ANSWER' } : { kind: 'answered', text }
  } finally {
    await handle.dispose()
  }
}
