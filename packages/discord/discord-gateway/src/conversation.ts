/**
 * Routing of admitted Discord messages into Agent Sessions, and of the agent's answer back to the
 * channel. One Discord channel maps to one live Session while the listener runs, so a conversation
 * keeps its history across turns; turns on one channel run one at a time.
 * @module @deepseek-ai/dsh-discord-gateway/conversation
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { boundContextSummary, createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import { awaitTurn, lastAssistantText, openUnattendedSession, sleep, type UnattendedSession } from '@deepseek-ai/dsh-unattended-session'
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
  const conversations = new Map<string, UnattendedSession>()
  const tails = new Map<string, Promise<void>>()

  /** Open the Session one channel converses in, mounted with the configured presets. */
  async function openConversation(channelId: string): Promise<UnattendedSession> {
    const selection = ctx.agentDefaultModel.currentSelection()
    return await openUnattendedSession(ctx, {
      sessionId: SessionId(`discord-${channelId}-${randomUUID()}`),
      agentPreset: settings.agentPreset,
      permissionPreset: settings.permissionPreset,
      workspacePath: settings.workspacePath,
      title: `${settings.titlePrefix} ${channelId}`,
      agentOptions: { provider: selection.provider, model: selection.model },
    }, signal)
  }

  /** Dispose one conversation's Agent, reporting rather than propagating a teardown failure. */
  async function disposeConversation(conversation: UnattendedSession): Promise<void> {
    try {
      await conversation.handle.dispose()
    } catch (error: unknown) {
      ctx.logger.warn(`discord-gateway: disposal of Session ${conversation.sessionId} failed: `
        + errorChain(error))
    }
  }

  /** Hand one message to the Session, wait for the answer, and post it to the channel. */
  async function runTurn(conversation: UnattendedSession, message: DiscordInboundMessage): Promise<void> {
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
    if (await awaitTurn(agent, { timeoutMs: settings.turnTimeoutMs, wait, signal }) !== 'idle') {
      ctx.logger.warn(`discord-gateway: turn for channel ${message.channelId} did not settle within `
        + `${String(settings.turnTimeoutMs)}ms; its answer is not posted and the conversation is released`)
      // The turn must not outlive the router's wait: an undisposed Agent keeps working while the
      // tail chain moves on, so the next message would follow up on a half-cancelled Session.
      // Turns on one channel are serialized by the tail chain, so this channel's entry is still
      // this conversation; disposal after a concurrent router.dispose() is a memoized no-op.
      conversations.delete(message.channelId)
      await disposeConversation(conversation)
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
      for (const conversation of live) await disposeConversation(conversation)
    },
  }
}
