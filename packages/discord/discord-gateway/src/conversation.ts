/**
 * Routing of admitted Discord messages into Agent Sessions, and of the agent's answers back to the
 * channel. One Discord channel maps to one durable conversation: the routing record lives in the
 * `discord-gateway` storage domain, so a restart resumes the same Session, an idle handle is
 * released while the record stays, and after enough silence the next message starts fresh. Turns on
 * one channel run one at a time; messages inside the debounce window join into one turn. Turns the
 * listener did not start — reminders, background-job notices — are posted to the channel too, so
 * every wake-up path reaches the person who is conversing.
 * @module @deepseek-ai/dsh-discord-gateway/conversation
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { CronRunOutcome } from '@deepseek-ai/dsh-cron'
import type { Agent, AgentHandle, AgentSetup } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { CommandDescriptor, CommandResult } from '@deepseek-ai/dsh-commands'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { boundContextSummary, createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type { AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-session-title'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { awaitTurn, lastAssistantText, openUnattendedSession, resumeUnattendedSession, sleep } from '@deepseek-ai/dsh-unattended-session'
import type { UnattendedSession } from '@deepseek-ai/dsh-unattended-session'
import type { DiscordActionRow, DiscordMessageBody } from '@deepseek-ai/dsh-tool-discord'
import { chunkContent, defangBroadcastMentions, discordRequest, postChannelMessage, postDiscordMessageBody, postTyping, sendDiscordMessage } from '@deepseek-ai/dsh-tool-discord'
import type {} from '@deepseek-ai/dsh-workspace'
import { approvalOutcomeForLine, approvalOutcomeForReaction, buildApprovalPrompt, buildQuestionPrompt, parseQuestionAnswer } from './answerers.ts'
import type { ConversationRecord, OutboxRecord } from './domain.ts'
import { DiscordOutbox } from './outbox.ts'
import { DiscordWakeCoordinator } from './wake.ts'
import { DISCORD_CHANNEL_TYPE_DM } from './gateway.ts'
import { discordCommands, registerGatewayCommands } from './commands.ts'
import type { DiscordInteraction } from './interactions.ts'
import { approvalControls, questionControls, renderCards, CONVERSATION_CONTROLS, DiscordPromptId } from './presentation.ts'
import type { DiscordInboundMessage, DiscordInboundReaction, GatewaySettings } from './types.ts'

/** What one settled scheduled run announces on the `cron/run-finished` event. */
interface FinishedCronRun {
  readonly outcome: CronRunOutcome
  readonly text: string
  readonly reportOutcome: boolean
}

/** Repeat interval for the typing indicator, fixed against Discord's own ~10-second expiry. */
const TYPING_INTERVAL_MS = 8_000

/** Who the listener answers and how guild channels are gated. Both lists hold validated snowflakes. */
export interface RoutingPolicy {
  /** User ids allowed to start or continue a conversation. */
  readonly allowedUserIds: ReadonlySet<string>
  /** Guild text channel ids the listener reads; direct messages need no entry here. */
  readonly allowedChannelIds: ReadonlySet<string>
  /** Guild channels are admitted only when the message mentions or replies to the bot. */
  readonly guildRequireMention: boolean
  /** The bot's own user id from the latest `READY`; empty until the first one arrives. */
  readonly botUserId: () => string
}

/** Delivery seam for an answer, so routing is testable without a network. */
export type ReplyPoster = (content: string, channelId: string, token: string, signal: AbortSignal) => Promise<void>

/** Delivery seam for the typing indicator. */
export type TypingPoster = (channelId: string, token: string, signal: AbortSignal) => Promise<void>

/** Delivery seam for an approval or question prompt; resolves the created message's id. */
export type PromptPoster = (
  content: string, channelId: string, token: string, signal: AbortSignal, components?: readonly DiscordActionRow[],
) => Promise<string>

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
  /** Durable conversation records, keyed by channel id. */
  readonly table: KvTable<string, ConversationRecord>
  /** Persisted delivery queue. Hosts provide it to enable restart recovery. */
  readonly outboxTable?: KvTable<string, OutboxRecord>
  /** Delay seam used by the per-turn bound, release and debounce timers, and reply retries. */
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>
  /** Reply delivery seam. Defaults to the Discord REST poster. */
  readonly post?: ReplyPoster
  /** Delivery seam for one already-bounded card. */
  readonly postRich?: (body: DiscordMessageBody, channelId: string, token: string, signal: AbortSignal) => Promise<void>
  /** Remove controls from a settled prompt without changing its text. */
  readonly clearPrompt?: (channelId: string, messageId: string, signal: AbortSignal) => Promise<void>
  /** Set or remove the bot's processing/completion reaction. */
  readonly react?: (message: DiscordInboundMessage, emoji: string, remove: boolean, signal: AbortSignal) => Promise<void>
  /** Current configured-preset command descriptors, including gateway controls. */
  readonly commands?: () => readonly CommandDescriptor[]
  /** Typing-indicator seam. Defaults to the Discord REST poster. */
  readonly type?: TypingPoster
  /** Prompt-delivery seam. Defaults to a single Discord REST post whose reply carries the id. */
  readonly prompt?: PromptPoster
}

/** One channel's live Agent and the bookkeeping proactive delivery needs. */
interface LiveConversation {
  readonly channelId: string
  readonly sessionId: SessionId
  readonly handle: AgentHandle
  /** Proactive scan floor: assistant text before this seq was delivered or predates this handle. */
  seqFloor: number
  /** True while the router awaits a turn it started; that turn's reply is posted by `runTurn`. */
  inboundActive: boolean
  /** Cancels the pending idle-release timer for this conversation. */
  cancelRelease: () => void
}

/** A channel's queued messages inside one debounce window. */
interface PendingBatch {
  readonly texts: string[]
  representative: DiscordInboundMessage
  cancel: () => void
}

/** One approval awaiting a reaction or yes/no in the channel that owns the conversation. */
interface PendingApproval {
  readonly kind: 'approval'
  readonly channelId: string
  /** Id of the prompt message whose reactions answer this request; empty when delivery omitted it. */
  promptMessageId: string
  readonly requestId: DiscordPromptId
  readonly answerLine: (line: string) => void
  readonly settle: (outcome: ApprovalOutcome) => void
  readonly cancel: () => void
}

/** One question request awaiting numbered or free-text answers, asked one question at a time. */
interface PendingQuestion {
  readonly kind: 'question'
  readonly channelId: string
  readonly questions: readonly AskUserQuestionItem[]
  promptMessageId: string
  requestId: DiscordPromptId
  nextIndex: number
  readonly answered: AskUserQuestionAnswerItem[]
  readonly answerLine: (line: string) => void
  readonly cancel: () => void
}

type PendingRequest = PendingApproval | PendingQuestion

/** Router that owns one durable conversation per Discord channel. */
export interface ConversationRouter {
  /** Restore queued deliveries and cold-session reminder timers. */
  recover(): Promise<void>
  /** Admit or ignore one gateway message, then answer it when admitted. */
  handle(message: DiscordInboundMessage): void
  /** Match one reaction against the channel's pending approval prompt. */
  handleReaction(reaction: DiscordInboundReaction): void
  /** Execute a native or text command without posting a second response. */
  execute(channelId: string, line: string, signal?: AbortSignal): Promise<CommandResult>
  /** Resolve a native control against the currently pending prompt. */
  component(interaction: Extract<DiscordInteraction, { kind: 'component' }>, signal?: AbortSignal): Promise<string>
  /** Post finished-run text to a channel; delivery failures are logged, never thrown. */
  deliver(channelId: string, content: string, deliveryId?: string): Promise<void>
  /** Dispose every live Agent and forget its channel; durable records stay. */
  dispose(): Promise<void>
}

/**
 * Decide whether one message is for this listener.
 * @param message - Parsed inbound Discord message.
 * @param policy - Allowed identities and guild mention requirements.
 * @returns whether the message may reach the router.
 */
export function isAdmitted(message: DiscordInboundMessage, policy: RoutingPolicy): boolean {
  if (message.bot) return false
  if (!policy.allowedUserIds.has(message.authorId)) return false
  if (message.channelType === DISCORD_CHANNEL_TYPE_DM) return true
  if (!policy.allowedChannelIds.has(message.channelId)) return false
  if (!policy.guildRequireMention) return true
  const bot = policy.botUserId()
  return bot !== '' && (message.mentionedUserIds.includes(bot) || message.replyToAuthorId === bot)
}

/**
 * Cut over-long inbound text, marking that the rest did not arrive.
 * @param content - Original message text.
 * @param maxChars - Maximum retained input length.
 * @returns bounded text with a truncation notice when needed.
 */
export function boundedContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  return `${content.slice(0, maxChars)}\n[truncated by the Discord listener]`
}

/** Final text is eligible only after its own turn commits a completed end record. */
function settledReplies(events: readonly SessionEvent[], firstSeq: number): { through: number; text: string }[] {
  const replies: { through: number; text: string }[] = []
  let text = ''
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') text = ''
    else if (event.type === 'assistant/message') {
      text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
    } else if (event.type === 'turn/end') {
      replies.push({ through: event.seq + 1, text: event.data.reason.kind === 'completed' ? text : '' })
      text = ''
    }
  }
  return replies
}

/**
 * Create the router that answers admitted Discord messages and forwards proactive turns.
 *
 * @param deps - host context, listener cancellation, deployment settings, allowlists, token source,
 *   durable record table, and the seams tests replace.
 * @returns the router, whose {@link ConversationRouter.dispose} releases every live Session it holds.
 */
export function createConversationRouter(deps: ConversationRouterDeps): ConversationRouter {
  const { ctx, settings } = deps
  const stopping = new AbortController()
  const signal = AbortSignal.any([deps.signal, stopping.signal])
  const wait = deps.wait ?? sleep
  const post: ReplyPoster = deps.post ?? (async (content, channelId, token, replySignal) => {
    await sendDiscordMessage({
      channel: channelId,
      post: postChannelMessage,
      wait,
      requestTimeoutMs: settings.replyRequestTimeoutMs,
      maxRetries: settings.replyMaxRetries,
      maxRetryWaitMs: settings.replyMaxRetryWaitMs,
      maxChunksPerCall: settings.replyMaxChunksPerCall,
    }, token, content, replySignal)
  })
  const type: TypingPoster = deps.type ?? ((channelId, token, typingSignal) => postTyping(channelId, token, typingSignal))
  const sender = (channel: string) => ({ channel, post: postChannelMessage, wait,
    requestTimeoutMs: settings.replyRequestTimeoutMs, maxRetries: settings.replyMaxRetries,
    maxRetryWaitMs: settings.replyMaxRetryWaitMs,
  })
  const postRich = deps.postRich ?? (async (body: DiscordMessageBody, channelId: string, token: string, replySignal: AbortSignal) => {
    await postDiscordMessageBody(sender(channelId), token, body, replySignal)
  })
  const prompt: PromptPoster = deps.prompt ?? (async (content, channelId, token, promptSignal, components) => {
    const chunks = chunkContent(defangBroadcastMentions(content).content)
    if (chunks.length > settings.replyMaxChunksPerCall) throw new Error('discord-gateway: prompt exceeds the message limit')
    let messageId = ''
    for (const [index, chunk] of chunks.entries()) {
      const reply = await postDiscordMessageBody(sender(channelId), token, { content: chunk,
        ...(index === chunks.length - 1 && components !== undefined ? { components } : {}),
      }, promptSignal)
      try {
        const created: unknown = JSON.parse(reply.body)
        messageId = typeof created === 'object' && created !== null && typeof (created as { id?: unknown }).id === 'string'
          ? (created as { id: string }).id : ''
      } catch {
        // The prompt was accepted; a malformed response leaves only the text-answer path available.
        messageId = ''
      }
    }
    return messageId
  })
  const background = new Set<Promise<void>>()
  function track(operation: Promise<void>): void {
    const caught = operation.catch((error: unknown) => {
      if (!signal.aborted) ctx.logger.warn(`discord-gateway: presentation failed: ${errorChain(error)}`)
    })
    background.add(caught)
    void caught.finally(() => { background.delete(caught) })
  }
  function clearPrompt(channelId: string, messageId: string): void {
    if (messageId === '' || !settings.answerers.includes('component') || signal.aborted) return
    track((async () => {
      if (deps.clearPrompt !== undefined) {
        await deps.clearPrompt(channelId, messageId, signal)
        return
      }
      using timeout = deadline(signal, settings.replyRequestTimeoutMs, 'DISCORD_EDIT_TIMEOUT')
      const reply = await discordRequest({ method: 'PATCH', path: `/channels/${channelId}/messages/${messageId}`,
        token: await deps.resolveToken(), body: { components: [], allowed_mentions: { parse: [] } },
      }, timeout.signal)
      if (reply.status < 200 || reply.status >= 300) throw new Error(`discord-gateway: prompt update rejected (HTTP ${String(reply.status)})`)
    })())
  }
  async function react(message: DiscordInboundMessage, emoji: string, remove = false): Promise<void> {
    const aborted = (): boolean => signal.aborted
    if (!settings.reactionStatus || aborted()) return
    try {
      if (deps.react !== undefined) {
        await deps.react(message, emoji, remove, signal)
        return
      }
      using timeout = deadline(signal, settings.replyRequestTimeoutMs, 'DISCORD_REACTION_TIMEOUT')
      const reply = await discordRequest({ method: remove ? 'DELETE' : 'PUT',
        path: `/channels/${message.channelId}/messages/${message.id}/reactions/${encodeURIComponent(emoji)}/@me`,
        token: await deps.resolveToken(),
      }, timeout.signal)
      if (reply.status < 200 || reply.status >= 300) throw new Error(`HTTP ${String(reply.status)}`)
    } catch (error: unknown) {
      if (!aborted()) ctx.logger.warn(`discord-gateway: status reaction failed: ${errorChain(error)}`)
    }
  }
  const conversations = new Map<string, LiveConversation>()
  const pendings = new Map<string, PendingRequest>()
  const tails = new Map<string, Promise<void>>()
  const batches = new Map<string, PendingBatch>()
  const inputs = new Map<string, { controller: AbortController; pending: number }>()
  const openings = new Map<string, { controller: AbortController; done: Promise<LiveConversation> }>()
  const deliveries = new Map<string, Promise<void>>()
  const outbox = deps.outboxTable === undefined ? undefined : new DiscordOutbox(
    deps.outboxTable, settings,
    async (channelId, content) => {
      const token = await deps.resolveToken()
      if (typeof content === 'string' && deps.post !== undefined) await deps.post(content, channelId, token, signal)
      else await postRich(typeof content === 'string' ? { content } : content, channelId, token, signal)
    },
    (message) => { ctx.logger.warn(message) },
  )
  const wakes = outbox === undefined ? undefined : new DiscordWakeCoordinator(
    ctx, deps.table,
    async (record) => {
      const previous = tails.get(record.channelId) ?? Promise.resolve()
      const input = channelInput(record.channelId)
      const inputAborted = (): boolean => input.controller.signal.aborted
      const waking = previous.then(async () => {
        signal.throwIfAborted()
        if (inputAborted()) return
        if (deps.table.get(record.channelId)?.sessionId !== record.sessionId
          || conversations.has(record.channelId)) return
        const live = await resumeConversation(record)
        if (inputAborted()) return
        if (live.handle.agent.status === 'idle') await flushDelivery(live, outbox)
      }).catch((error: unknown) => {
        if (!inputAborted()) throw error
      })
      tails.set(record.channelId, waking.catch(() => {}))
      await waking
    }, channelId => conversations.has(channelId), settings.wakeRetryMs,
  )

  /** Find the live conversation one Agent belongs to. */
  function findLive(agent: Agent): LiveConversation | undefined {
    for (const conversation of conversations.values()) {
      if (conversation.handle.agent === agent) return conversation
    }
    return undefined
  }

  /** Post one answer or notice to the channel, reporting rather than propagating a failure. */
  async function postReply(channelId: string, content: string | readonly DiscordMessageBody[], deliveryId = randomUUID()): Promise<void> {
    try {
      if (outbox === undefined) {
        const token = await deps.resolveToken()
        if (typeof content === 'string') await post(content, channelId, token, signal)
        else for (const body of content) await postRich(body, channelId, token, signal)
      }
      else await outbox.enqueue(deliveryId, channelId, content)
    } catch (error: unknown) {
      ctx.logger.warn(`discord-gateway: reply to channel ${channelId} failed: ${errorChain(error)}`)
    }
  }

  async function notice(channelId: string, text: string, title = 'Conversation', error = false): Promise<void> {
    await postReply(channelId, settings.richMessages
      ? renderCards(text, { title, color: error ? 0xed4245 : settings.accentColor, controls: CONVERSATION_CONTROLS })
      : text)
  }

  /** Release one channel's live Agent; with `deleteRecord`, its durable record goes too. */
  async function releaseConversation(channelId: string, deleteRecord: boolean): Promise<void> {
    wakes?.cancel(channelId)
    pendings.get(channelId)?.cancel()
    const live = conversations.get(channelId)
    if (live !== undefined) {
      conversations.delete(channelId)
      live.cancelRelease()
      try {
        await live.handle.dispose()
      } catch (error: unknown) {
        ctx.logger.warn(`discord-gateway: disposal of Session ${live.sessionId} failed: `
          + errorChain(error))
      }
    }
    if (deleteRecord) await deps.table.delete(channelId)
    else await wakes?.refresh(channelId)
  }

  /** Arm the idle release for one conversation; a new message or disposal cancels it first. */
  function armRelease(conversation: LiveConversation): void {
    conversation.cancelRelease()
    const controller = new AbortController()
    conversation.cancelRelease = () => { controller.abort() }
    wait(settings.idleReleaseMs, controller.signal).then(async () => {
      if (conversations.get(conversation.channelId) !== conversation || conversation.inboundActive
        || conversation.handle.agent.status === 'running' || pendings.has(conversation.channelId)) return
      conversations.delete(conversation.channelId)
      try {
        await conversation.handle.dispose()
        await wakes?.refresh(conversation.channelId)
      } catch (error: unknown) {
        ctx.logger.warn(`discord-gateway: idle release of Session ${conversation.sessionId} failed: `
          + errorChain(error))
      }
    }, () => {
      // The release timer was cancelled by newer activity or by router disposal; nothing to report.
    })
  }

  /** The waiting-request line of `/status`, naming what the channel's next answer means. */
  function pendingNote(channelId: string): string {
    const pending = pendings.get(channelId)
    if (pending?.kind === 'approval') return 'Approval waiting for your answer.'
    if (pending?.kind === 'question') return 'Question waiting for your answer.'
    const live = conversations.get(channelId)
    if (live?.handle.agent.status === 'running') return 'Turn in progress.'
    if (live?.inboundActive === true) {
      const last = live.handle.agent.session.ownEvents().findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
      return last?.type === 'turn/end' ? 'Delivering the reply.' : 'Turn in progress.'
    }
    return 'Idle.'
  }

  function channelInput(channelId: string) {
    let input = inputs.get(channelId)
    if (input === undefined) {
      input = { controller: new AbortController(), pending: 0 }
      inputs.set(channelId, input)
    }
    return input
  }

  /** Cancel already-admitted input while keeping a published Agent available for later messages. */
  function cancelPendingInput(channelId: string) {
    const input = inputs.get(channelId)
    const batch = batches.get(channelId)
    const opening = openings.get(channelId)
    input?.controller.abort()
    inputs.delete(channelId)
    batch?.cancel()
    batches.delete(channelId)
    opening?.controller.abort()
    return { queued: (input?.pending ?? 0) > 0 || batch !== undefined || opening !== undefined,
      opening: opening?.done, previous: tails.get(channelId) }
  }

  /** Later input waits for both a cancelled turn and its conversation control to settle. */
  function retainControl(channelId: string, previous: Promise<void> | undefined, operation: Promise<unknown>): void {
    tails.set(channelId, Promise.allSettled([previous, operation]).then(() => {}))
  }

  /** The commands this listener owns, closed over one channel. */
  function commandOps(channelId: string) {
    return {
      startFresh: async (): Promise<string> => {
        const cancelled = cancelPendingInput(channelId)
        const reset = (async () => {
          await Promise.allSettled([cancelled.opening])
          await releaseConversation(channelId, true)
        })()
        retainControl(channelId, cancelled.previous, reset)
        await reset
        return 'Fresh conversation: your next message starts a new Session.'
      },
      status: (): string => {
        const record = deps.table.get(channelId)
        if (record === undefined) return 'No conversation yet: your next message starts one.'
        const live = conversations.get(channelId)
        return [
          `Session: ${record.sessionId}`,
          `Agent preset: ${record.agentPreset}`,
          `Permission preset: ${settings.permissionPreset}`,
          live === undefined ? 'State: released (resumes on your next message)' : 'State: live',
          pendingNote(channelId),
          `Queued deliveries: ${String(outbox?.pending(channelId) ?? 0)}`,
        ].join('\n')
      },
      stopTurn: async (): Promise<string> => {
        const cancelled = cancelPendingInput(channelId)
        const pending = pendings.get(channelId)
        if (pending !== undefined) pending.cancel()
        const live = conversations.get(channelId)
        const running = live !== undefined && (live.inboundActive || live.handle.agent.status === 'running')
        if (running) live.handle.agent.cancel({ kind: 'user' })
        const stopped = Promise.allSettled([cancelled.opening])
        retainControl(channelId, cancelled.previous, stopped)
        await stopped
        if (running) return pending !== undefined ? 'Cancelled the waiting request and the running turn.' : 'Cancelled the running turn.'
        if (pending !== undefined) return 'Cancelled the waiting request.'
        return cancelled.queued ? 'Cancelled the pending messages.' : 'Nothing is running in this conversation.'
      },
    }
  }

  /** Setup composed inside each conversation Agent's scope: the channel's gateway commands. */
  function conversationSetup(channelId: string): AgentSetup {
    return (agentCtx) => {
      registerGatewayCommands(agentCtx, commandOps(channelId))
    }
  }

  function toLive(channelId: string, sessionId: SessionId, handle: AgentHandle): LiveConversation {
    return {
      channelId,
      sessionId,
      handle,
      seqFloor: handle.agent.session.seq,
      inboundActive: false,
      cancelRelease: () => {},
    }
  }

  /** Startup cancellation remains separate from the lifetime of an already-published Agent. */
  function openConversation(channelId: string, open: (openingSignal: AbortSignal) => Promise<LiveConversation>): Promise<LiveConversation> {
    const controller = new AbortController()
    const done = open(AbortSignal.any([signal, controller.signal]))
    const opening = { controller, done }
    openings.set(channelId, opening)
    const retire = (): void => { if (openings.get(channelId) === opening) openings.delete(channelId) }
    void done.then(retire, retire)
    return done
  }

  /** Publish only after startup and its durable routing record survive cancellation. */
  async function publishConversation(channelId: string, opened: UnattendedSession, openingSignal: AbortSignal,
    previous?: ConversationRecord): Promise<LiveConversation> {
    try {
      openingSignal.throwIfAborted()
      if (previous === undefined) {
        const now = Date.now()
        await deps.table.put(channelId, { channelId, sessionId: opened.sessionId,
          agentPreset: settings.agentPreset, workspacePath: settings.workspacePath, openedAt: now, lastInboundAt: now,
          deliveredThrough: opened.handle.agent.session.seq })
      }
      openingSignal.throwIfAborted()
      const conversation = toLive(channelId, opened.sessionId, opened.handle)
      conversation.seqFloor = previous?.deliveredThrough ?? conversation.seqFloor
      conversations.set(channelId, conversation)
      armRelease(conversation)
      return conversation
    } catch (error: unknown) {
      try { await opened.workspace.detachSession(opened.sessionId) } finally { await opened.handle.dispose() }
      if (previous === undefined && deps.table.get(channelId)?.sessionId === opened.sessionId) await deps.table.delete(channelId)
      throw error
    }
  }

  /** Open a fresh Session for one channel and record it durably. */
  async function createConversation(channelId: string): Promise<LiveConversation> {
    return await openConversation(channelId, async (openingSignal) => {
      wakes?.cancel(channelId)
      const selection = ctx.agentDefaultModel.currentSelection()
      const opened = await openUnattendedSession(ctx, {
        sessionId: SessionId(`discord-${channelId}-${randomUUID()}`),
        agentPreset: settings.agentPreset,
        permissionPreset: settings.permissionPreset,
        workspacePath: settings.workspacePath,
        title: `${settings.titlePrefix} ${channelId}`,
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: conversationSetup(channelId),
      }, openingSignal)
      return await publishConversation(channelId, opened, openingSignal)
    })
  }

  /** Resume the Session one record points at, mounted with the configured presets and commands. */
  async function resumeConversation(record: ConversationRecord): Promise<LiveConversation> {
    return await openConversation(record.channelId, async (openingSignal) => {
      wakes?.cancel(record.channelId)
      const selection = ctx.agentDefaultModel.currentSelection()
      const opened = await resumeUnattendedSession(ctx, {
        sessionId: SessionId(record.sessionId),
        agentPreset: settings.agentPreset,
        permissionPreset: settings.permissionPreset,
        workspacePath: settings.workspacePath,
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: conversationSetup(record.channelId),
      }, openingSignal)
      return await publishConversation(record.channelId, opened, openingSignal, record)
    })
  }

  /** The live conversation for one inbound message, resuming or replacing the durable record. */
  async function ensureConversation(channelId: string, inputSignal: AbortSignal): Promise<LiveConversation> {
    inputSignal.throwIfAborted()
    const record = deps.table.get(channelId)
    if (record !== undefined && Date.now() - record.lastInboundAt > settings.conversationMaxAgeMs) {
      await releaseConversation(channelId, true)
    } else {
      const live = conversations.get(channelId)
      if (live !== undefined) return live
      if (record !== undefined) {
        try {
          return await resumeConversation(record)
        } catch (error: unknown) {
          inputSignal.throwIfAborted()
          if (!(error instanceof SessionPersistenceNotFoundError)) throw error
          ctx.logger.warn(`discord-gateway: Session ${record.sessionId} for channel ${channelId} `
            + 'has no durable log anymore; starting a fresh conversation')
          await deps.table.delete(channelId)
        }
      }
    }
    inputSignal.throwIfAborted()
    return await createConversation(channelId)
  }

  /**
   * Ask one channel for an approval and wait for a reaction, a yes/no reply, or expiry. Only one
   * request waits per channel: a newer request cancels the older one, because a text answer cannot
   * name which prompt it belongs to.
   */
  async function askApproval(conversation: LiveConversation, req: ApprovalRequest): Promise<ApprovalOutcome> {
    const channelId = conversation.channelId
    pendings.get(channelId)?.cancel()
    if (signal.aborted || req.signal?.aborted === true) return 'cancelled'
    return await new Promise<ApprovalOutcome>((resolve) => {
      const controller = new AbortController()
      let settled = false
      const isSettled = (): boolean => settled
      const cancel = (): void => { settle('cancelled') }
      const settle = (outcome: ApprovalOutcome): void => {
        if (settled) return
        settled = true
        pendings.delete(channelId)
        controller.abort()
        req.signal?.removeEventListener('abort', cancel)
        signal.removeEventListener('abort', cancel)
        clearPrompt(channelId, entry.promptMessageId)
        resolve(outcome)
      }
      const entry: PendingApproval = {
        kind: 'approval', channelId, promptMessageId: '', requestId: DiscordPromptId(randomUUID()),
        answerLine: (line: string): void => {
          const outcome = approvalOutcomeForLine(line)
          if (outcome !== undefined) settle(outcome)
        },
        settle, cancel,
      }
      pendings.set(channelId, entry)
      req.signal?.addEventListener('abort', cancel, { once: true })
      signal.addEventListener('abort', cancel, { once: true })
      track((async () => {
        try {
          const text = buildApprovalPrompt(req.toolName, req.reason, settings.answerers, settings.approvalTimeoutMs)
          const messageId = await prompt(text, channelId, await deps.resolveToken(), AbortSignal.any([signal, controller.signal]),
            settings.answerers.includes('component') ? approvalControls(entry.requestId) : undefined)
          if (isSettled()) clearPrompt(channelId, messageId)
          else entry.promptMessageId = messageId
        } catch (error: unknown) {
          if (isSettled()) return
          ctx.logger.warn(`discord-gateway: approval prompt for channel ${channelId} failed: ${errorChain(error)}`)
          settle('unavailable')
        }
      })())
      wait(settings.approvalTimeoutMs, controller.signal).then(() => {
        settle('cancelled')
        track(notice(channelId, 'The approval request expired; the action was not taken.', 'Approval expired'))
      }, () => {
        // Settlement aborts this timer; the recorded outcome owns the answer.
      })
    })
  }

  /** Ask questions in order; each prompt has its own one-use identity. */
  async function askQuestions(
    conversation: LiveConversation,
    request: { questions: readonly AskUserQuestionItem[]; signal?: AbortSignal },
  ): Promise<AskUserQuestionAnswer> {
    const channelId = conversation.channelId
    pendings.get(channelId)?.cancel()
    if (signal.aborted || request.signal?.aborted === true) throw new UserQuestionError('The question was cancelled.', 'ASK_ABORTED')
    return await new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      const controller = new AbortController()
      let settled = false
      const cancel = (): void => { fail(new UserQuestionError('The question was cancelled.', 'ASK_ABORTED')) }
      const finish = (): void => {
        settled = true
        pendings.delete(channelId)
        controller.abort()
        request.signal?.removeEventListener('abort', cancel)
        signal.removeEventListener('abort', cancel)
        clearPrompt(channelId, entry.promptMessageId)
      }
      const fail = (error: UserQuestionError): void => {
        if (settled) return
        finish()
        reject(error)
      }
      const ask = (index: number): void => {
        entry.requestId = DiscordPromptId(randomUUID())
        entry.promptMessageId = ''
        const requestId = entry.requestId
        track((async () => {
          try {
            // The asker rejects empty question lists before dispatch.
            const question = entry.questions[index] as AskUserQuestionItem
            const messageId = await prompt(buildQuestionPrompt(question, index, entry.questions.length, settings.answerers),
              channelId, await deps.resolveToken(), AbortSignal.any([signal, controller.signal]),
              settings.answerers.includes('component') ? questionControls(question, requestId) : undefined)
            if (settled || entry.requestId !== requestId) clearPrompt(channelId, messageId)
            else entry.promptMessageId = messageId
          } catch (error: unknown) {
            if (settled || entry.requestId !== requestId) return
            ctx.logger.warn(`discord-gateway: question prompt for channel ${channelId} failed: ${errorChain(error)}`)
            fail(new UserQuestionError('the Discord listener could not deliver the question', 'ASK_UNAVAILABLE'))
          }
        })())
      }
      const entry: PendingQuestion = {
        kind: 'question', channelId, questions: request.questions, requestId: DiscordPromptId(''), promptMessageId: '', nextIndex: 0, answered: [],
        answerLine: (line: string): void => {
          if (settled) return
          const question = entry.questions[entry.nextIndex] as AskUserQuestionItem
          const item = parseQuestionAnswer(question, line)
          if (item === undefined) return
          clearPrompt(channelId, entry.promptMessageId)
          entry.promptMessageId = ''
          entry.answered.push(item)
          entry.nextIndex += 1
          if (entry.nextIndex >= entry.questions.length) {
            finish()
            resolve({ answers: entry.answered })
          } else ask(entry.nextIndex)
        },
        cancel,
      }
      pendings.set(channelId, entry)
      request.signal?.addEventListener('abort', cancel, { once: true })
      signal.addEventListener('abort', cancel, { once: true })
      wait(settings.questionTimeoutMs, controller.signal).then(() => {
        fail(new UserQuestionError(`the Discord user did not answer within ${String(settings.questionTimeoutMs)}ms`, 'ASK_TIMEOUT'))
        track(notice(channelId, 'The question expired without an answer.', 'Question expired'))
      }, () => {
        // Settlement aborts this timer; the completed answer or rejection owns the outcome.
      })
      ask(0)
    })
  }

  /** Repeat the typing indicator until the returned controller aborts. Best-effort by design. */
  function startTyping(channelId: string): AbortController {
    const controller = new AbortController()
    track((async () => {
      let token: string
      try {
        token = await deps.resolveToken()
      } catch {
        // Without a token there is no indicator to send; the turn itself reports its own failure.
        return
      }
      const aborted = (): boolean => controller.signal.aborted
      while (!aborted()) {
        try {
          await type(channelId, token, controller.signal)
        } catch (error: unknown) {
          // An abort mid-request is the turn ending on purpose, not an indicator failure.
          if (aborted()) return
          ctx.logger.warn(`discord-gateway: typing indicator for channel ${channelId} stopped: `
            + errorChain(error))
          return
        }
        try {
          await wait(TYPING_INTERVAL_MS, controller.signal)
        } catch {
          return
        }
      }
    })())
    return controller
  }

  /** Hand one message to the Session, wait for the answer, and post it to the channel. */
  async function runTurn(conversation: LiveConversation, message: DiscordInboundMessage, inputSignal: AbortSignal): Promise<void> {
    const agent = conversation.handle.agent
    const firstSeq = agent.session.seq
    conversation.inboundActive = true
    let typing: AbortController | undefined
    try {
      if (settings.typingIndicator) typing = startTyping(message.channelId)
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
      const settled = await awaitTurn(agent, { timeoutMs: settings.turnTimeoutMs, wait, signal })
      if (inputSignal.aborted) return
      if (settled !== 'idle') {
        ctx.logger.warn(`discord-gateway: turn for channel ${message.channelId} did not settle within `
          + `${String(settings.turnTimeoutMs)}ms; its answer is not posted and the conversation is released`)
        // The turn must not outlive the router's wait: an undisposed Agent keeps working while the
        // tail chain moves on, so the next message would follow up on a half-cancelled Session.
        // Turns on one channel are serialized by the tail chain, so this channel's entry is still
        // this conversation; disposal after a concurrent router.dispose() is a memoized no-op.
        await releaseConversation(message.channelId, false)
        if (!signal.aborted) await notice(message.channelId, 'The request timed out. Please try again or start a new conversation.', 'Request timed out', true)
        return
      }
      if (outbox !== undefined) await flushDelivery(conversation, outbox)
      else {
        const reply = lastAssistantText(agent.session.ownEvents(), firstSeq)
        conversation.seqFloor = agent.session.seq
        if (reply !== '') await postReply(message.channelId, reply)
      }
    } finally {
      typing?.abort()
      conversation.inboundActive = false
    }
  }

  /** Run one admitted message's turn and stamp the durable record with its arrival. */
  async function processInbound(message: DiscordInboundMessage, inputSignal: AbortSignal): Promise<void> {
    const inputAborted = (): boolean => inputSignal.aborted
    const processing = react(message, '👀')
    let success = false
    try {
      const conversation = await ensureConversation(message.channelId, inputSignal)
      if (inputAborted()) return
      conversation.cancelRelease()
      const firstSeq = conversation.handle.agent.session.seq
      await runTurn(conversation, message, inputSignal)
      if (inputAborted()) return
      const ending = conversation.handle.agent.session.ownEvents().filter(event => event.seq >= firstSeq).findLast(event => event.type === 'turn/end')
      success = ending?.type === 'turn/end' && ending.data.reason.kind === 'completed'
      if (ending?.type === 'turn/end' && ending.data.reason.kind === 'error' && !signal.aborted) {
        await notice(message.channelId, 'I could not finish that request. Please try again.', 'Request failed', true)
      }
      const record = deps.table.get(message.channelId)
      if (record !== undefined) await deps.table.put(message.channelId, { ...record, lastInboundAt: Date.now() })
      if (conversations.get(message.channelId) === conversation) armRelease(conversation)
    } finally {
      track(processing.then(async () => {
        await react(message, '👀', true)
        await react(message, success ? '✅' : '❌')
      }))
    }
  }

  /** Native and text commands use the same scoped registry and conversation operations. */
  async function execute(channelId: string, line: string, requestSignal?: AbortSignal): Promise<CommandResult> {
    const commandSignal = requestSignal === undefined ? signal : AbortSignal.any([signal, requestSignal])
    commandSignal.throwIfAborted()
    const parsed = parseCommand(line)
    if (parsed === undefined) return { kind: 'error', text: 'Enter a slash command.' }
    if (settings.excludedPresetCommands.includes(parsed.name)) return { kind: 'error', text: `/${parsed.name} is not available through Discord.` }
    const ops = commandOps(channelId)
    const live = conversations.get(channelId)
    if (parsed.name === 'help') {
      const commands = live === undefined
        ? (deps.commands?.() ?? discordCommands([]))
        : discordCommands(ctx.commands.list(live.handle.agent), settings.excludedPresetCommands)
      return { kind: 'success', text: commands.map(command => `**/${command.name}** — ${command.description}`
        + (command.input === undefined ? '' : `\n  Arguments: ${command.input.hint}`)).join('\n') }
    }
    if (live === undefined) {
      if (parsed.name === 'new') return { kind: 'success', text: await ops.startFresh() }
      if (parsed.name === 'status') return { kind: 'success', text: ops.status() }
      if (parsed.name === 'stop') return { kind: 'success', text: await ops.stopTurn() }
      return { kind: 'error', text: `No conversation is live: send a message first, then /${parsed.name} works.` }
    }
    const runsTurns = !['new', 'status', 'stop'].includes(parsed.name)
    if (runsTurns && (live.inboundActive || live.handle.agent.status === 'running')) {
      return { kind: 'error', text: 'A turn is running. Wait for it to finish or use /stop first.' }
    }
    if (runsTurns) { live.inboundActive = true; live.cancelRelease() }
    try {
      const execution = await ctx.commands.execute(live.handle.agent, line, [], commandSignal)
      return execution?.result ?? { kind: 'error', text: `/${parsed.name} is not a known command.` }
    } finally {
      if (runsTurns && conversations.get(channelId) === live) {
        live.inboundActive = false
        try {
          if (live.handle.agent.status !== 'running') {
            if (outbox !== undefined) await flushDelivery(live, outbox)
            else {
              const text = lastAssistantText(live.handle.agent.session.ownEvents(), live.seqFloor)
              live.seqFloor = live.handle.agent.session.seq
              if (text !== '') await postReply(channelId, text)
            }
          }
        } finally { armRelease(live) }
      }
    }
  }

  async function dispatchCommand(channelId: string, line: string): Promise<void> {
    const result = await execute(channelId, line)
    await notice(channelId, result.text ?? 'Done.', `/${parseCommand(line)?.name ?? 'command'}`, result.kind === 'error')
  }

  /** Drain a channel's pending debounce batch into one turn, if one is waiting. */
  function flushBatch(channelId: string): void {
    const batch = batches.get(channelId)
    if (batch === undefined) return
    batches.delete(channelId)
    batch.cancel()
    enqueue(channelId, mergeBatch(batch))
  }

  function mergeBatch(batch: PendingBatch): DiscordInboundMessage {
    return { ...batch.representative, content: batch.texts.join('\n') }
  }

  /** Queue one unit of work on the channel's serial tail. */
  function enqueue(channelId: string, message: DiscordInboundMessage): void {
    const input = channelInput(channelId)
    input.pending += 1
    const turn = (tails.get(channelId) ?? Promise.resolve())
      .then(async () => {
        signal.throwIfAborted()
        if (input.controller.signal.aborted) return
        await processInbound(message, input.controller.signal)
      })
      .catch(async (error: unknown) => {
        if (signal.aborted || input.controller.signal.aborted) return
        ctx.logger.warn(`discord-gateway: message ${message.id} failed: ${errorChain(error)}`)
        await notice(channelId, 'I could not finish that request. Please try again.', 'Request failed', true)
      }).finally(() => { input.pending -= 1 })
    tails.set(channelId, turn)
  }

  /** Checkpoint final text into the outbox before advancing the durable session scan floor. */
  async function enqueueReplies(
    queue: DiscordOutbox, channelId: string, sessionId: string, events: readonly SessionEvent[], firstSeq: number,
  ): Promise<number> {
    let through = firstSeq
    for (const reply of settledReplies(events, firstSeq)) {
      if (reply.text !== '') await queue.enqueue(`session:${sessionId}:${String(reply.through)}`, channelId, reply.text)
      const current = deps.table.get(channelId)
      if (current?.sessionId === sessionId) await deps.table.put(channelId, { ...current, deliveredThrough: reply.through })
      through = reply.through
    }
    return through
  }

  /** Serialize scans so a failed enqueue leaves every undelivered turn eligible for the next scan. */
  async function flushDelivery(conversation: LiveConversation, queue: DiscordOutbox): Promise<void> {
    const operation = (deliveries.get(conversation.channelId) ?? Promise.resolve()).then(async () => {
      if (!await ctx.sessions.flush(conversation.handle.agent.session)) {
        throw new Error('Discord final reply has no confirmed session persistence')
      }
      conversation.seqFloor = await enqueueReplies(queue, conversation.channelId, conversation.sessionId,
        conversation.handle.agent.session.ownEvents(), conversation.seqFloor)
    })
    deliveries.set(conversation.channelId, operation.catch(() => {}))
    await operation
  }

  /** Proactive delivery: a settled turn the router did not start posts its final text to the channel. */
  ctx.effect(() => ctx.on('agent/status', ({ agent, status }) => {
    const conversation = findLive(agent)
    if (conversation === undefined) return
    if (status === 'running') {
      conversation.cancelRelease()
      return
    }
    if (conversation.inboundActive) return
    if (outbox !== undefined) {
      void flushDelivery(conversation, outbox).catch((error: unknown) => {
        ctx.logger.warn(`discord-gateway: final reply remains in session ${conversation.sessionId}: ${String(error)}`)
      }).finally(() => { armRelease(conversation) })
      return
    }
    armRelease(conversation)
    const text = lastAssistantText(agent.session.ownEvents(), conversation.seqFloor)
    conversation.seqFloor = agent.session.seq
    if (text === '') return
    void postReply(conversation.channelId, text)
  }), 'discord-gateway proactive delivery')

  // Answer-side registrations for the interaction waterfalls. The router claims a request only when
  // it owns the asking Agent. Prepend keeps remote bridges from claiming Discord interactions
  // when a Web client connects before the gateway mounts or reloads.
  ctx.effect(() => ctx.on('approval/request', (req, next) => {
    const conversation = findLive(req.agent)
    if (conversation === undefined) return next()
    return askApproval(conversation, req)
  }, { prepend: true }), 'discord-gateway approval answerer')

  ctx.effect(() => ctx.on('user-questions/request', (request, next) => {
    if (request.agent === undefined) return next()
    const conversation = findLive(request.agent)
    if (conversation === undefined) return next()
    return askQuestions(conversation, request)
  }, { prepend: true }), 'discord-gateway question answerer')

  return {
    async recover(): Promise<void> {
      if (outbox === undefined) return
      outbox.start()
      for (const [channelId, record] of deps.table.entries()) {
        signal.throwIfAborted()
        try {
          const handle = await ctx.sessionPersistence.open(SessionId(record.sessionId), 'read', { signal })
          try {
            const { events } = await handle.read(undefined, undefined, { signal })
            if (record.deliveredThrough === undefined) {
              await deps.table.put(channelId, { ...record, deliveredThrough: events.length })
            } else {
              await enqueueReplies(outbox, channelId, record.sessionId, events, record.deliveredThrough)
            }
          } finally { await handle.close() }
        } catch (error: unknown) {
          ctx.logger.warn(`discord-gateway: delivery recovery for ${record.sessionId} failed: ${String(error)}`)
        }
      }
      await wakes?.start()
    },
    handle(message: DiscordInboundMessage): void {
      if (!isAdmitted(message, deps.policy)) return
      if (message.content.trim() === '') return
      const line = message.content.trim()
      if (parseCommand(line) === undefined) {
        // While a request waits, the next text in this channel is its answer, not a new turn.
        const pending = pendings.get(message.channelId)
        if (pending !== undefined) {
          if (settings.answerers.includes('text') || (pending.kind === 'question' && settings.answerers.includes('component')
            && questionControls(pending.questions[pending.nextIndex] as AskUserQuestionItem, pending.requestId).length === 0)) {
            pending.answerLine(line)
          }
          return
        }
      }
      if (parseCommand(line) !== undefined) {
        flushBatch(message.channelId)
        // Commands run immediately rather than on the channel's serial tail: `/stop` must be able
        // to cancel a turn that is running right now, not queue behind it.
        track(dispatchCommand(message.channelId, line).catch(async (error: unknown) => {
          ctx.logger.warn(`discord-gateway: command for message ${message.id} failed: `
            + errorChain(error))
          if (!signal.aborted) await notice(message.channelId, 'The command could not finish. Please try again.', 'Command failed', true)
        }))
        return
      }
      if (settings.inboundDebounceMs <= 0) {
        enqueue(message.channelId, message)
        return
      }
      const pending = batches.get(message.channelId)
      /* v8 ignore next -- the placeholder cancel is replaced by the armed timer before any caller can reach it. */
      const batch: PendingBatch = pending ?? { texts: [], representative: message, cancel: () => {} }
      if (pending !== undefined) pending.cancel()
      batch.texts.push(message.content)
      batch.representative = message
      const controller = new AbortController()
      batch.cancel = () => { controller.abort() }
      batches.set(message.channelId, batch)
      wait(settings.inboundDebounceMs, controller.signal).then(() => {
        if (batches.get(message.channelId) !== batch) return
        batches.delete(message.channelId)
        enqueue(message.channelId, mergeBatch(batch))
      }, () => {
        // The window was extended by a newer message or the router was disposed; whoever replaced
        // this timer owns the batch now.
      })
    },

    execute,
    async component(interaction, requestSignal): Promise<string> {
      signal.throwIfAborted()
      requestSignal?.throwIfAborted()
      if (!deps.policy.allowedUserIds.has(interaction.userId)
        || (interaction.guildId !== '' && !deps.policy.allowedChannelIds.has(interaction.channelId))) {
        return 'This control is not available to you in this channel.'
      }
      const parts = interaction.customId.split(':')
      if (parts[0] !== 'dsh') return 'This control is no longer available.'
      if (parts[1] === 'command' && parts.length === 3 && ['status', 'stop', 'new'].includes(parts[2] ?? '')) {
        return (await execute(interaction.channelId, `/${parts[2] ?? ''}`, requestSignal)).text ?? 'Done.'
      }
      if (!settings.answerers.includes('component')) return 'Native answers are disabled.'
      const pending = pendings.get(interaction.channelId)
      if (pending === undefined || pending.promptMessageId !== interaction.messageId || pending.requestId !== parts[2]) {
        return 'This request has expired or was already answered.'
      }
      if (pending.kind === 'approval' && parts[1] === 'approval' && parts.length === 4) {
        const outcome = approvalOutcomeForLine(parts[3] ?? '')
        if (outcome !== undefined) {
          pending.settle(outcome)
          return outcome === 'allowed-once' ? 'Allowed once.' : 'Rejected.'
        }
      }
      if (pending.kind === 'question' && parts[1] === 'question' && parts.length === 3) {
        const question = pending.questions[pending.nextIndex]
        const line = interaction.values.join(',')
        if (question !== undefined && parseQuestionAnswer(question, line) !== undefined) {
          pending.answerLine(line)
          return 'Answer saved.'
        }
      }
      return 'That answer is not valid for this request.'
    },

    handleReaction(reaction: DiscordInboundReaction): void {
      if (!settings.answerers.includes('reaction')) return
      if (!deps.policy.allowedUserIds.has(reaction.userId)) return
      const pending = pendings.get(reaction.channelId)
      if (pending === undefined || pending.kind !== 'approval') return
      if (reaction.messageId !== pending.promptMessageId) return
      const outcome = approvalOutcomeForReaction(reaction.emojiName)
      if (outcome !== undefined) pending.settle(outcome)
    },

    deliver(channelId: string, content: string, deliveryId = randomUUID()): Promise<void> {
      return outbox === undefined ? postReply(channelId, content) : outbox.enqueue(deliveryId, channelId, content)
    },
    async dispose(): Promise<void> {
      stopping.abort()
      await wakes?.dispose()
      const live = [...conversations.values()]
      conversations.clear()
      for (const batch of batches.values()) batch.cancel()
      batches.clear()
      for (const conversation of live) {
        conversation.cancelRelease()
        try {
          await conversation.handle.dispose()
        } catch (error: unknown) {
          ctx.logger.warn(`discord-gateway: disposal of Session ${conversation.sessionId} failed: `
            + errorChain(error))
        }
      }
      await Promise.allSettled([...tails.values(), ...deliveries.values()])
      while (background.size > 0) await Promise.allSettled([...background])
      tails.clear()
      await outbox?.dispose()
    },
  }
}

/** Words delivered when a scheduled run has no text of its own and the operator wants to know. */
const CRON_OUTCOME_LINES: Record<CronRunOutcome, string | undefined> = {
  answered: undefined,
  'no-text-answer': 'The scheduled run finished without a text answer.',
  'timed-out': 'The scheduled run timed out.',
  interrupted: 'The scheduled run was interrupted.',
  failed: 'The scheduled run could not start.',
}

/**
 * Select the final text or requested outcome notice for one finished cron run.
 * @param run - Finished result and outcome-reporting preference.
 * @returns delivery text, or undefined when the run has nothing to announce.
 */
export function cronDeliveryContent(run: FinishedCronRun): string | undefined {
  if (run.text !== '') return run.text
  if (!run.reportOutcome) return undefined
  return CRON_OUTCOME_LINES[run.outcome]
}

/**
 * Listen for finished cron runs on this host and deliver each one to its channel. Runs without a
 * delivery target, or with nothing worth posting, pass by silently.
 * @param ctx - registrant context carrying the event bus.
 * @param router - conversation router whose {@link ConversationRouter.deliver} posts to channels.
 */
export function attachCronDelivery(ctx: Context, router: ConversationRouter): void {
  ctx.on('cron/run-finished', async (payload) => {
    if (payload.deliverChannelId === undefined) return
    const content = cronDeliveryContent(payload)
    if (content !== undefined) await router.deliver(payload.deliverChannelId, content,
      `cron:${payload.sessionId}:${String(payload.firedAt)}`)
    return true
  })
}
