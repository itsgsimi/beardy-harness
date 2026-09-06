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
import type { Agent, AgentHandle, AgentSetup } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { boundContextSummary, createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-title'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { awaitTurn, lastAssistantText, openUnattendedSession, resumeUnattendedSession, sleep } from '@deepseek-ai/dsh-unattended-session'
import { postChannelMessage, postTyping, sendDiscordMessage } from '@deepseek-ai/dsh-tool-discord'
import type {} from '@deepseek-ai/dsh-workspace'
import type { ConversationRecord } from './domain.ts'
import { DISCORD_CHANNEL_TYPE_DM } from './gateway.ts'
import { registerGatewayCommands } from './commands.ts'
import type { DiscordInboundMessage, GatewaySettings } from './types.ts'

/** Delivery bounds borrowed from the Discord delivery package rather than restated as new tunables. */
const REPLY_REQUEST_TIMEOUT_MS = 15_000
const REPLY_MAX_RETRIES = 2
const REPLY_MAX_RETRY_WAIT_MS = 30_000
const REPLY_MAX_CHUNKS = 10

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
  /** Delay seam used by the per-turn bound, release and debounce timers, and reply retries. */
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>
  /** Reply delivery seam. Defaults to the Discord REST poster. */
  readonly post?: ReplyPoster
  /** Typing-indicator seam. Defaults to the Discord REST poster. */
  readonly type?: TypingPoster
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

/** Router that owns one durable conversation per Discord channel. */
export interface ConversationRouter {
  /** Admit or ignore one gateway message, then answer it when admitted. */
  handle(message: DiscordInboundMessage): void
  /** Dispose every live Agent and forget its channel; durable records stay. */
  dispose(): Promise<void>
}

/** Decide whether one message is for this listener. */
export function isAdmitted(message: DiscordInboundMessage, policy: RoutingPolicy): boolean {
  if (message.bot) return false
  if (!policy.allowedUserIds.has(message.authorId)) return false
  if (message.channelType === DISCORD_CHANNEL_TYPE_DM) return true
  if (!policy.allowedChannelIds.has(message.channelId)) return false
  if (!policy.guildRequireMention) return true
  const bot = policy.botUserId()
  return bot !== '' && (message.mentionedUserIds.includes(bot) || message.replyToAuthorId === bot)
}

/** Cut over-long inbound text, marking that the rest did not arrive. */
export function boundedContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  return `${content.slice(0, maxChars)}\n[truncated by the Discord listener]`
}

/**
 * Create the router that answers admitted Discord messages and forwards proactive turns.
 *
 * @param deps - host context, listener cancellation, deployment settings, allowlists, token source,
 *   durable record table, and the seams tests replace.
 * @returns the router, whose {@link ConversationRouter.dispose} releases every live Session it holds.
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
  const type: TypingPoster = deps.type ?? ((channelId, token, typingSignal) => postTyping(channelId, token, typingSignal))
  const conversations = new Map<string, LiveConversation>()
  const tails = new Map<string, Promise<void>>()
  const batches = new Map<string, PendingBatch>()

  /** Find the live conversation one Agent belongs to. */
  function findLive(agent: Agent): LiveConversation | undefined {
    for (const conversation of conversations.values()) {
      if (conversation.handle.agent === agent) return conversation
    }
    return undefined
  }

  /** Post one answer or notice to the channel, reporting rather than propagating a failure. */
  async function postReply(channelId: string, content: string): Promise<void> {
    try {
      await post(content, channelId, await deps.resolveToken(), signal)
    } catch (error: unknown) {
      ctx.logger.warn(`discord-gateway: reply to channel ${channelId} failed: ${errorChain(error)}`)
    }
  }

  /** Release one channel's live Agent; with `deleteRecord`, its durable record goes too. */
  async function releaseConversation(channelId: string, deleteRecord: boolean): Promise<void> {
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
  }

  /** Arm the idle release for one conversation; a new message or disposal cancels it first. */
  function armRelease(conversation: LiveConversation): void {
    conversation.cancelRelease()
    const controller = new AbortController()
    conversation.cancelRelease = () => { controller.abort() }
    wait(settings.idleReleaseMs, controller.signal).then(async () => {
      if (conversations.get(conversation.channelId) !== conversation || conversation.inboundActive) return
      conversations.delete(conversation.channelId)
      try {
        await conversation.handle.dispose()
      } catch (error: unknown) {
        ctx.logger.warn(`discord-gateway: idle release of Session ${conversation.sessionId} failed: `
          + errorChain(error))
      }
    }, () => {
      // The release timer was cancelled by newer activity or by router disposal; nothing to report.
    })
  }

  /** The commands this listener owns, closed over one channel. */
  function commandOps(channelId: string) {
    return {
      startFresh: async (): Promise<string> => {
        await releaseConversation(channelId, true)
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
          live?.inboundActive === true ? 'Turn in progress.' : 'Idle.',
        ].join('\n')
      },
      stopTurn: (): string => {
        const live = conversations.get(channelId)
        if (live === undefined || !live.inboundActive) return 'Nothing is running in this conversation.'
        live.handle.agent.cancel({ kind: 'user' })
        return 'Cancelled the running turn.'
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

  /** Open a fresh Session for one channel and record it durably. */
  async function createConversation(channelId: string): Promise<LiveConversation> {
    const selection = ctx.agentDefaultModel.currentSelection()
    const opened = await openUnattendedSession(ctx, {
      sessionId: SessionId(`discord-${channelId}-${randomUUID()}`),
      agentPreset: settings.agentPreset,
      permissionPreset: settings.permissionPreset,
      workspacePath: settings.workspacePath,
      title: `${settings.titlePrefix} ${channelId}`,
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: conversationSetup(channelId),
    }, signal)
    const conversation = toLive(channelId, opened.sessionId, opened.handle)
    conversations.set(channelId, conversation)
    armRelease(conversation)
    const now = Date.now()
    await deps.table.put(channelId, {
      channelId,
      sessionId: opened.sessionId,
      agentPreset: settings.agentPreset,
      workspacePath: settings.workspacePath,
      openedAt: now,
      lastInboundAt: now,
    })
    return conversation
  }

  /** Resume the Session one record points at, mounted with the configured presets and commands. */
  async function resumeConversation(record: ConversationRecord): Promise<LiveConversation> {
    const selection = ctx.agentDefaultModel.currentSelection()
    const opened = await resumeUnattendedSession(ctx, {
      sessionId: SessionId(record.sessionId),
      agentPreset: settings.agentPreset,
      permissionPreset: settings.permissionPreset,
      workspacePath: settings.workspacePath,
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: conversationSetup(record.channelId),
    }, signal)
    const conversation = toLive(record.channelId, opened.sessionId, opened.handle)
    conversations.set(record.channelId, conversation)
    armRelease(conversation)
    return conversation
  }

  /** The live conversation for one inbound message, resuming or replacing the durable record. */
  async function ensureConversation(channelId: string): Promise<LiveConversation> {
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
          if (!(error instanceof SessionPersistenceNotFoundError)) throw error
          ctx.logger.warn(`discord-gateway: Session ${record.sessionId} for channel ${channelId} `
            + 'has no durable log anymore; starting a fresh conversation')
          await deps.table.delete(channelId)
        }
      }
    }
    return await createConversation(channelId)
  }

  /** Repeat the typing indicator until the returned controller aborts. Best-effort by design. */
  function startTyping(channelId: string): AbortController {
    const controller = new AbortController()
    void (async () => {
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
    })()
    return controller
  }

  /** Hand one message to the Session, wait for the answer, and post it to the channel. */
  async function runTurn(conversation: LiveConversation, message: DiscordInboundMessage): Promise<void> {
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
      if (await awaitTurn(agent, { timeoutMs: settings.turnTimeoutMs, wait, signal }) !== 'idle') {
        ctx.logger.warn(`discord-gateway: turn for channel ${message.channelId} did not settle within `
          + `${String(settings.turnTimeoutMs)}ms; its answer is not posted and the conversation is released`)
        // The turn must not outlive the router's wait: an undisposed Agent keeps working while the
        // tail chain moves on, so the next message would follow up on a half-cancelled Session.
        // Turns on one channel are serialized by the tail chain, so this channel's entry is still
        // this conversation; disposal after a concurrent router.dispose() is a memoized no-op.
        await releaseConversation(message.channelId, false)
        return
      }
      const reply = lastAssistantText(agent.session.ownEvents(), firstSeq)
      conversation.seqFloor = agent.session.seq
      if (reply === '') return
      await postReply(message.channelId, reply)
    } finally {
      typing?.abort()
      conversation.inboundActive = false
    }
  }

  /** Run one admitted message's turn and stamp the durable record with its arrival. */
  async function processInbound(message: DiscordInboundMessage): Promise<void> {
    const conversation = await ensureConversation(message.channelId)
    conversation.cancelRelease()
    await runTurn(conversation, message)
    const record = deps.table.get(message.channelId)
    if (record !== undefined) {
      await deps.table.put(message.channelId, { ...record, lastInboundAt: Date.now() })
    }
    armRelease(conversation)
  }

  /** Dispatch one slash-command line against the channel's conversation Agent. */
  async function dispatchCommand(channelId: string, line: string): Promise<void> {
    const parsed = parseCommand(line)
    /* v8 ignore next -- dispatchCommand is only reached for a line that already parsed. */
    if (parsed === undefined) return
    const ops = commandOps(channelId)
    const live = conversations.get(channelId)
    if (live === undefined) {
      // The gateway's own commands answer from durable state; nothing else can run without a
      // live Agent, and answering a command must never open a Session by surprise.
      if (parsed.name === 'new') await postReply(channelId, await ops.startFresh())
      else if (parsed.name === 'status') await postReply(channelId, ops.status())
      else if (parsed.name === 'stop') await postReply(channelId, ops.stopTurn())
      else await postReply(channelId, `No conversation is live: send a message first, then /${parsed.name} works.`)
      return
    }
    // A preset command can run Agent turns of its own; mark the conversation busy so proactive
    // delivery stays silent while they settle, then move the floor past whatever they committed.
    // The gateway's own commands only read, cancel, or release state and must not touch the flag.
    const runsTurns = parsed.name !== 'new' && parsed.name !== 'status' && parsed.name !== 'stop'
    if (runsTurns) live.inboundActive = true
    try {
      const execution = await ctx.commands.execute(live.handle.agent, line, [], signal)
      if (execution === undefined) {
        await postReply(channelId, `/${parsed.name} is not a known command.`)
        return
      }
      const text = execution.result.kind === 'error'
        ? execution.result.text
        : execution.result.text ?? 'Done.'
      await postReply(channelId, text)
    } finally {
      if (runsTurns && conversations.get(channelId) === live) {
        live.seqFloor = live.handle.agent.session.seq
        live.inboundActive = false
      }
    }
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
    const turn = (tails.get(channelId) ?? Promise.resolve())
      .then(async () => {
        signal.throwIfAborted()
        await processInbound(message)
      })
      .catch((error: unknown) => {
        ctx.logger.warn(`discord-gateway: message ${message.id} failed: ${errorChain(error)}`)
      })
    tails.set(channelId, turn)
  }

  /** Proactive delivery: a settled turn the router did not start posts its final text to the channel. */
  ctx.effect(() => ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    const conversation = findLive(agent)
    if (conversation === undefined || conversation.inboundActive) return
    const text = lastAssistantText(agent.session.ownEvents(), conversation.seqFloor)
    conversation.seqFloor = agent.session.seq
    if (text === '') return
    void postReply(conversation.channelId, text)
  }), 'discord-gateway proactive delivery')

  return {
    handle(message: DiscordInboundMessage): void {
      if (!isAdmitted(message, deps.policy)) return
      if (message.content.trim() === '') return
      const line = message.content.trim()
      if (parseCommand(line) !== undefined) {
        flushBatch(message.channelId)
        // Commands run immediately rather than on the channel's serial tail: `/stop` must be able
        // to cancel a turn that is running right now, not queue behind it.
        void dispatchCommand(message.channelId, line).catch((error: unknown) => {
          ctx.logger.warn(`discord-gateway: command for message ${message.id} failed: `
            + errorChain(error))
        })
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

    async dispose(): Promise<void> {
      const live = [...conversations.values()]
      conversations.clear()
      tails.clear()
      for (const batch of batches.values()) batch.cancel()
      batches.clear()
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
