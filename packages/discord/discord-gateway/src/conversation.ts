/**
 * Routing of admitted Discord messages into Agent Sessions, and of the agent's answer back to the
 * channel. One Discord channel maps to one live Session while the listener runs, so a conversation
 * keeps its history across turns; turns on one channel run one at a time.
 * @module @deepseek-ai/dsh-discord-gateway/conversation
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { boundContextSummary, createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import { postChannelMessage, sendDiscordMessage } from '@deepseek-ai/dsh-tool-discord'
import type {} from '@deepseek-ai/dsh-workspace'
import { DISCORD_CHANNEL_TYPE_DM } from './gateway.ts'
import type { DiscordInboundMessage, GatewaySettings } from './types.ts'

/** Delivery bounds borrowed from the Discord delivery package rather than restated as new tunables. */
const REPLY_REQUEST_TIMEOUT_MS = 15_000
const REPLY_MAX_RETRIES = 2
const REPLY_MAX_RETRY_WAIT_MS = 30_000
const REPLY_MAX_CHUNKS = 10

/** Who the listener answers. Both lists hold Discord snowflakes from validated configuration. */
export interface RoutingPolicy {
  /** User ids allowed to start or continue a conversation. */
  readonly allowedUserIds: ReadonlySet<string>
  /** Guild text channel ids the listener reads; direct messages need no entry here. */
  readonly allowedChannelIds: ReadonlySet<string>
}

/** Delivery seam for the answer, so routing is testable without a network. */
export type ReplyPoster = (content: string, channelId: string, token: string, signal: AbortSignal) => Promise<void>

/** Everything the router needs from the host and the deployment. */
export interface ConversationRouterDeps {
  /** Context that owns the created Agents, so disposal follows the fiber. */
  readonly ctx: Context
  /** Cancellation of the listener this router serves. */
  readonly signal: AbortSignal
  readonly settings: GatewaySettings
  readonly policy: RoutingPolicy
  /** Resolved bot token for outbound posts; rejects when the credential is absent. */
  readonly resolveToken: () => Promise<string>
  /** Delay seam used by the per-turn bound and reply retries. */
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>
  /** Reply delivery seam. Defaults to the Discord REST poster. */
  readonly post?: ReplyPoster
}

/** One live conversation and its Agent handle. */
interface Conversation {
  readonly sessionId: SessionId
  readonly handle: AgentHandle
}

/** Router that owns one conversation per Discord channel. */
export interface ConversationRouter {
  /** Admit or ignore one gateway message, then answer it when admitted. */
  handle(message: DiscordInboundMessage): void
  /** Dispose every live Agent and forget its channel. */
  dispose(): Promise<void>
}

/** Decide whether one message is for this listener. */
export function isAdmitted(message: DiscordInboundMessage, policy: RoutingPolicy): boolean {
  if (message.bot) return false
  if (!policy.allowedUserIds.has(message.authorId)) return false
  return message.channelType === DISCORD_CHANNEL_TYPE_DM || policy.allowedChannelIds.has(message.channelId)
}

/** Cut over-long inbound text, marking that the rest did not arrive. */
export function boundedContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  return `${content.slice(0, maxChars)}\n[truncated by the Discord listener]`
}

/** Last assistant text committed at or after `firstSeq`, which is what the channel should see. */
export function lastAssistantText(events: readonly SessionEvent[], firstSeq: number): string {
  let text = ''
  for (const event of events) {
    if (event.seq < firstSeq || event.type !== 'assistant/message') continue
    const joined = event.data.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    if (joined !== '') text = joined
  }
  return text
}

/** Wait for one turn to settle, reporting false when the configured bound expires first. */
async function settlesInTime(
  idle: Promise<void>,
  timeoutMs: number,
  wait: (ms: number, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): Promise<boolean> {
  const outcome = await new Promise<'idle' | 'timeout'>((resolve) => {
    void wait(timeoutMs, signal).then(
      () => { resolve('timeout') },
      () => { resolve('timeout') },
    )
    idle.then(() => { resolve('idle') }, () => { resolve('timeout') })
  })
  return outcome === 'idle'
}

/** Sleep until `ms` passes or the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Create the router that answers admitted Discord messages.
 *
 * @param deps - host context, listener cancellation, deployment settings, allowlists, token source,
 *   and the two seams tests replace.
 * @returns the router, whose {@link ConversationRouter.dispose} releases every Session it opened.
 */
export function createConversationRouter(deps: ConversationRouterDeps): ConversationRouter {
  const { ctx, settings, signal } = deps
  const wait = deps.wait ?? sleep
  const post: ReplyPoster = deps.post ?? (async (content, channelId, token, replySignal) => {
    await sendDiscordMessage({
      channel: channelId,
      post: postChannelMessage,
      wait,
      requestTimeoutMs: REPLY_REQUEST_TIMEOUT_MS,
      maxRetries: REPLY_MAX_RETRIES,
      maxRetryWaitMs: REPLY_MAX_RETRY_WAIT_MS,
      maxChunksPerCall: REPLY_MAX_CHUNKS,
    }, token, content, replySignal)
  })
  const conversations = new Map<string, Conversation>()
  const tails = new Map<string, Promise<void>>()

  /** Open the Session one channel converses in, mounted with the configured presets. */
  async function openConversation(channelId: string): Promise<Conversation> {
    const preset = await ctx.agentPresets.resolve(settings.agentPreset)
    ctx.permissionPresets.resolve(settings.permissionPreset)
    const workspace = await ctx.workspaceRegistry.create(settings.workspacePath)
    const sessionId = SessionId(`discord-${channelId}-${randomUUID()}`)
    const selection = ctx.agentDefaultModel.currentSelection()
    const handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: workspace.path, agentPreset: preset.id },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: async (agentCtx) => {
        await ctx.agentPresets.mount(agentCtx, preset.id)
      },
    })
    let attached = false
    try {
      signal.throwIfAborted()
      await workspace.attachSession(sessionId)
      attached = true
      ctx.permissionPresets.set(handle.agent.session, settings.permissionPreset)
      ctx.sessionTitle.rename(handle.agent.session, `${settings.titlePrefix} ${channelId}`)
    } catch (error: unknown) {
      if (attached) await workspace.detachSession(sessionId)
      await handle.dispose()
      throw error
    }
    return { sessionId, handle }
  }

  /** Hand one message to the Session, wait for the answer, and post it to the channel. */
  async function runTurn(conversation: Conversation, message: DiscordInboundMessage): Promise<void> {
    const agent = conversation.handle.agent
    const firstSeq = agent.session.seq
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: boundedContent(message.content, settings.maxInputChars) }],
      source: {
        kind: 'discord',
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        authorId: message.authorId,
        form: 'notice',
        summary: boundContextSummary(`Discord message from ${message.authorId}`),
      },
    }))
    if (!await settlesInTime(agent.whenIdle(), settings.turnTimeoutMs, wait, signal)) {
      ctx.logger.warn(`discord-gateway: turn for channel ${message.channelId} did not settle within `
        + `${String(settings.turnTimeoutMs)}ms; its answer is not posted`)
      return
    }
    const reply = lastAssistantText(agent.session.ownEvents(), firstSeq)
    if (reply === '') return
    try {
      await post(reply, message.channelId, await deps.resolveToken(), signal)
    } catch (error: unknown) {
      ctx.logger.warn(`discord-gateway: reply to channel ${message.channelId} failed: ${errorChain(error)}`)
    }
  }

  return {
    handle(message: DiscordInboundMessage): void {
      if (!isAdmitted(message, deps.policy)) return
      if (message.content.trim() === '') return
      const turn = (tails.get(message.channelId) ?? Promise.resolve())
        .then(async () => {
          signal.throwIfAborted()
          let conversation = conversations.get(message.channelId)
          if (conversation === undefined) {
            conversation = await openConversation(message.channelId)
            conversations.set(message.channelId, conversation)
          }
          await runTurn(conversation, message)
        })
        .catch((error: unknown) => {
          ctx.logger.warn(`discord-gateway: message ${message.id} failed: ${errorChain(error)}`)
        })
      tails.set(message.channelId, turn)
    },

    async dispose(): Promise<void> {
      const live = [...conversations.values()]
      conversations.clear()
      tails.clear()
      for (const conversation of live) {
        try {
          await conversation.handle.dispose()
        } catch (error: unknown) {
          ctx.logger.warn(`discord-gateway: disposal of Session ${conversation.sessionId} failed: `
            + errorChain(error))
        }
      }
    },
  }
}
