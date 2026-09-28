/**
 * Shared fake of everything the conversation router touches: services, the durable record table,
 * the delivery seams, and the event capture needed to drive proactive delivery. Not a spec file.
 */

import { vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { DiscordActionRow, DiscordMessageBody } from '@deepseek-ai/dsh-tool-discord'
import { Session, SessionId, SessionLogOffset, SessionSeq, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { createConversationRouter } from '../src/conversation.ts'
import type { RoutingPolicy } from '../src/conversation.ts'
import type { ConversationRecord, OutboxRecord } from '../src/domain.ts'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import type { ConversationLane, DiscordInboundMessage, GatewaySettings, LaneToolFilter } from '../src/types.ts'

export const USER = '138391763999129600'
export const CHANNEL = '1472404859679670455'
export const GUILD_CHANNEL = '1478276183543119914'
export const BOT_USER = '111111111111111111'

/** Complete logged fixtures for proactive-reply scans. */
export function turnStartEvent(seq: number, turn: number): SessionEvent<'turn/start'> {
  return { seq: SessionSeq(seq), time: Date.now(), type: 'turn/start', data: { turn } }
}

export function assistantTextEvent(seq: number, turn: number, text: string): SessionEvent<'assistant/message'> {
  return {
    seq: SessionSeq(seq), time: Date.now(), type: 'assistant/message', surfaceOp: 'append',
    data: { turn, step: 1, message: createAssistantMessage({
      content: [{ type: 'text', text }], source: { provider: 'fixture', model: 'fixture' },
    }), stream: [] },
  }
}

export function turnEndEvent(seq: number, turn: number, reason: TurnEndReason = { kind: 'completed' }): SessionEvent<'turn/end'> {
  return { seq: SessionSeq(seq), time: Date.now(), type: 'turn/end', data: { turn, reason } }
}

export function stepEndEvent(seq: number, turn: number, step: number): SessionEvent<'step/end'> {
  return { seq: SessionSeq(seq), time: Date.now(), type: 'step/end', data: { turn, step } }
}

/** In-memory durable-table fake with the full table API. */
export function tableFromMap<K extends string, V>(records: Map<K, V>, parse: (value: V) => V = value => value): KvTable<K, V> {
  return {
    get: key => records.get(key),
    entries: () => [...records.entries()].values(),
    keys: () => [...records.keys()].values(),
    get size() { return records.size },
    put: async (key, value) => { records.set(key, parse(value)) },
    delete: async key => records.delete(key),
    update: async (key, fn) => {
      const current = records.get(key)
      if (current === undefined) throw new Error(`missing table key: ${key}`)
      const next = parse(fn(current))
      records.set(key, next)
      return next
    },
  }
}

/** Settings that keep every timer in the router inert unless a test arms it deliberately. */
export const SETTINGS: GatewaySettings = {
  excludedPresetCommands: ['export'], richMessages: false, accentColor: 0x5865f2, reactionStatus: false,
  replyRequestTimeoutMs: 15000, replyMaxRetries: 2, replyMaxRetryWaitMs: 30000, replyMaxChunksPerCall: 10,
  interactionMaxPending: 100, interactionReceiptLimit: 1000,
  outboxMaxPending: 100, outboxMaxChars: 20000, outboxRetryMs: 1000,
  outboxMaxRetryMs: 60000, outboxMaxReceipts: 1000, wakeRetryMs: 30000,
  workspacePath: '/workspace',
  agentPreset: 'beardy',
  permissionPreset: 'danger-full-access',
  userLanes: new Map(),
  titlePrefix: 'Discord',
  maxInputChars: 400,
  turnTimeoutMs: 1_000,
  idleReleaseMs: 60_000,
  conversationMaxAgeMs: 3_600_000,
  inboundDebounceMs: 0,
  guildRequireMention: false,
  typingIndicator: false,
  approvalTimeoutMs: 60_000,
  questionTimeoutMs: 60_000,
  answerers: ['reaction', 'text'],
}

/** A DM channel with no mentions; tests override what they exercise. */
export function inbound(overrides: Partial<DiscordInboundMessage> = {}): DiscordInboundMessage {
  return {
    id: 'm1',
    channelId: CHANNEL,
    guildId: '',
    authorId: USER,
    bot: false,
    channelType: 1,
    content: 'is the build green?',
    mentionedUserIds: [],
    replyToAuthorId: '',
    ...overrides,
  }
}

export function record(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    channelId: CHANNEL,
    sessionId: 'discord-old-session',
    agentPreset: 'beardy',
    workspacePath: '/workspace',
    openedAt: Date.now() - 60_000,
    lastInboundAt: Date.now(),
    ...overrides,
  }
}

export interface HarnessOptions {
  readonly modelSelection?: ModelSelection
  readonly modelEfforts?: readonly string[]
  readonly unresolvedModel?: boolean
  readonly defaultSelection?: ModelSelection
  /** Real Agent used for an approval routed through a live conversation. */
  readonly approvalAgent?: Agent
  /** Real dispatcher for tests that exercise listener ordering and disposal. */
  readonly eventContext?: Context
  readonly richMessages?: boolean
  readonly reactionStatus?: boolean
  readonly outboxStorage?: KvTable<string, OutboxRecord>
  readonly storedEvents?: SessionEvent[]
  readonly turnTimeoutMs?: number
  readonly idleReleaseMs?: number
  readonly conversationMaxAgeMs?: number
  readonly inboundDebounceMs?: number
  readonly typingIndicator?: boolean
  readonly guildRequireMention?: boolean
  /** Never resolve whenIdle, simulating a turn that outlives its bound. */
  readonly hang?: boolean
  readonly failAttach?: boolean
  readonly failPost?: boolean
  readonly failToken?: boolean
  /** Assistant text the turn commits; empty means the agent answered with no text. */
  readonly replyText?: string
  /** Reject whenIdle, as a turn that fails outright does. */
  readonly rejectIdle?: boolean
  /** Reject the delay seam instead of waiting on the router's own sleep. */
  readonly rejectWait?: boolean
  /** Leave out the post seam so the router's Discord transport runs. */
  readonly useDefaultPost?: boolean
  /** Fail the title step, after the session is already attached. */
  readonly failTitle?: boolean
  /** Durable record present before any message arrives. */
  readonly initialRecord?: ConversationRecord
  /** How `agents.resume` fails when a record points at a Session. */
  readonly resumeError?: 'not-found' | 'other'
  /** Fail the typing-indicator seam. */
  readonly failType?: boolean
  /** Reject the typing seam only when its signal aborts, simulating a request in flight at turn end. */
  readonly slowType?: boolean
  /** Capture delay-seam resolvers instead of sleeping, so a test can fire windows by hand. */
  readonly manualWait?: boolean
  /** Result the fake command registry answers for a registered command name. */
  readonly commandOutcome?: { kind: 'success' | 'error'; text?: string }
  /** Approval wait used by the router; short values let expiry tests run quickly. */
  readonly approvalTimeoutMs?: number
  /** Question wait used by the router. */
  readonly questionTimeoutMs?: number
  /** Message id the prompt seam reports for every delivered prompt. */
  readonly promptId?: string
  /** Fail the prompt-delivery seam. */
  readonly failPrompt?: boolean
  /** Hold the prompt POST acknowledgement until the test releases it. */
  readonly promptBarrier?: Promise<void>
  readonly promptResult?: (ordinal: number) => Promise<string>
  /** Leave out the prompt seam so the router's Discord transport runs for prompts. */
  readonly useDefaultPrompt?: boolean
  /** Leave out the prompt-clear seam so the router edits the real Discord message. */
  readonly useDefaultClearPrompt?: boolean
  /** Leave out the reaction seam so status reactions use the Discord transport. */
  readonly useDefaultReact?: boolean
  /** Reply forms the router accepts; defaults to both. */
  readonly answerers?: readonly ('component' | 'reaction' | 'text')[]
  /** Allowlisted users; defaults to {@link USER} alone. */
  readonly allowedUserIds?: readonly string[]
  /** Own lanes keyed by user id; their keys also form the policy's lane users. */
  readonly userLanes?: ReadonlyMap<string, ConversationLane>
  /** Default-lane tool restriction. */
  readonly toolFilter?: LaneToolFilter
  /** Lane command catalog seam used while no conversation is live. */
  readonly commands?: (lane: ConversationLane) => readonly CommandDescriptor[]
  readonly statusDetails?: () => readonly string[]
  /** Attachment store the default image poster reads from; absent leaves no store mounted. */
  readonly attachments?: { readImage(ref: unknown, signal?: AbortSignal): Promise<{ data: Uint8Array }> }
}

/** Context carrying the services the router touches, recording every call it makes. */
export function harness(options: HarnessOptions = {}) {
  const calls: string[] = []
  const selections: ModelSelection[] = []
  const warnings: string[] = []
  const events: SessionEvent[] = options.storedEvents ?? []
  const eventHandlers = new Map<string, ((payload: Record<string, unknown>, next: () => Promise<never>) => unknown)[]>()
  const registeredCommands = new Map<string, { name: string; description: string; handler: (invocation: { agent: unknown }) => unknown }>()
  let idleResolve: () => void = () => {}
  const agentId = SessionId('discord-fixture-agent')
  const session = Session.create(agentId)
  vi.spyOn(session, 'ownEvents').mockImplementation(() => events)
  vi.spyOn(session, 'seq', 'get').mockImplementation(() => SessionLogOffset(events.length))
  const agent: Agent & { status: Agent['status'] } = {
    id: agentId,
    ctx: new Context(),
    options: {},
    inbox: unsupportedInbox(),
    status: 'idle',
    session,
    send: () => {}, steer: () => {}, inject: () => {},
    runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal),
    followup(message: UserMessage) {
      calls.push(`followup:${message.content.find(block => block.type === 'text')?.text ?? ''}`)
      if (options.replyText !== undefined) {
        if (options.outboxStorage !== undefined || options.reactionStatus === true) {
          events.push(turnStartEvent(events.length, 1))
        }
        events.push(assistantTextEvent(events.length, 1, options.replyText))
        if (options.outboxStorage !== undefined || options.reactionStatus === true) {
          events.push(turnEndEvent(events.length, 1))
        }
      }
    },
    cancel: (cause: unknown) => { calls.push(`cancel:${JSON.stringify(cause)}`) },
    whenIdle: () => {
      if (options.rejectIdle) return Promise.reject(new Error('turn failed'))
      return new Promise<void>((resolve) => {
        if (!options.hang) resolve()
        else idleResolve = resolve
      })
    },
  }
  const handle = {
    agent: options.approvalAgent ?? agent,
    dispose: vi.fn(async () => { calls.push('dispose') }),
  }
  const agentCtx = {
    inject: (_services: string[], apply: (ctx: unknown) => void) => { apply(agentCtx) },
    tools: {
      restrict: (filter: LaneToolFilter) => { calls.push(`restrict:${JSON.stringify(filter)}`); return () => {} },
    },
    commands: {
      list: () => [...registeredCommands.values()].map(({ name,description }) => ({ name,description })),
      register: (definition: { name: string; description: string; handler: (invocation: { agent: unknown }) => unknown }) => {
        calls.push(`cmd:${definition.name}`)
        registeredCommands.set(definition.name, definition)
        return () => { registeredCommands.delete(definition.name) }
      },
    },
  }
  const ctx = {
    get: (name: string) => name === 'llm' ? { resolveModelInfo: async (provider: string, model: string) => {
      if (options.unresolvedModel) throw new Error(`no adapter registered for provider "${provider}"`)
      return { provider, id: model, name: model, reasoning: {
        efforts: (options.modelEfforts ?? ['low', 'medium', 'high']).map(id => ({ id, name: id })),
      } }
    } } : name === 'attachments' ? options.attachments : options.eventContext?.[name as keyof Context],
    sessions: { flush: async () => true },
    sessionPersistence: {
      open: async () => ({ inheritedEventCount: 0, read: async () => ({ events }), close: async () => {} }),
    },
    logger: { info: vi.fn(), warn: (message: string) => { warnings.push(message) }, error: vi.fn(), debug: vi.fn() },
    effect: (fn: () => (() => void | Promise<void>)) => options.eventContext === undefined
      ? fn()
      : options.eventContext.effect(fn),
    on: (
      event: string,
      handler: (payload: Record<string, unknown>, next: () => Promise<never>) => unknown,
      listenerOptions?: { prepend?: boolean },
    ) => {
      if (options.eventContext !== undefined) {
        return options.eventContext.on(event as never, handler as never, listenerOptions)
      }
      const list = eventHandlers.get(event) ?? []
      list.push(handler)
      eventHandlers.set(event, list)
      return () => { list.splice(list.indexOf(handler), 1) }
    },
    permissionPresets: {
      resolve: (name: string) => { calls.push(`permission-resolve:${name}`); return {} },
      set: (_session: unknown, name: string) => { calls.push(`permission-set:${name}`) },
    },
    agentDefaultModel: { currentSelection: () => options.defaultSelection ?? { provider: 'p', model: 'm' } },
    agentPresets: {
      resolve: async (name: string) => { calls.push(`preset-resolve:${name}`); return { id: name } },
      acquireScope: async (name: string) => { calls.push(`scope:${name}`); return { key: {}, [Symbol.asyncDispose]: async () => {} } },
      mount: async (_ctx: unknown, name: string) => { calls.push(`mount:${name}`) },
    },
    workspaceRegistry: {
      create: async (path: string) => {
        calls.push(`workspace:${path}`)
        return {
          path,
          attachSession: async () => {
            calls.push('attach')
            if (options.failAttach) throw new Error('attach failed')
          },
          detachSession: async () => { calls.push('detach') },
        }
      },
    },
    agents: {
      create: async (createOptions: {
        setup?: (ctx: unknown) => Promise<void>
        agentOptions: ModelSelection
      }) => {
        calls.push('agent-create')
        selections.push(createOptions.agentOptions)
        await createOptions.setup?.(agentCtx)
        return handle
      },
      resume: async (resumeOptions: {
        resumeSessionId: string
        setup?: (ctx: unknown) => Promise<void>
        agentOptions: ModelSelection
      }) => {
        calls.push(`agent-resume:${resumeOptions.resumeSessionId}`)
        selections.push(resumeOptions.agentOptions)
        if (options.resumeError === 'not-found') {
          throw new SessionPersistenceNotFoundError(resumeOptions.resumeSessionId as never)
        }
        if (options.resumeError === 'other') throw new Error('persistence backend down')
        await resumeOptions.setup?.(agentCtx)
        return handle
      },
    },
    commands: {
      list: () => [...registeredCommands.values()].map(({ name, description }) => ({ name, description })),
      execute: async (execAgent: unknown, line: string) => {
        const name = line.slice(1).split(/\s/, 1)[0] ?? ''
        calls.push(`execute:${name}`)
        if (name === 'bogus') return undefined
        const definition = registeredCommands.get(name)
        if (definition !== undefined) {
          const result = await definition.handler({ agent: execAgent })
          return { commandId: 'cmd-1', result }
        }
        return {
          commandId: 'cmd-1',
          result: options.commandOutcome ?? { kind: 'success', text: `ran /${name}` },
        }
      },
    },
    sessionTitle: {
      rename: (_session: unknown, title: string) => {
        calls.push(`title:${title}`)
        if (options.failTitle) throw new Error('title failed')
      },
    },
  }

  const records = new Map<string, ConversationRecord>()
  if (options.initialRecord !== undefined) records.set(options.initialRecord.channelId, options.initialRecord)
  const table = {
    records,
    get: (key: string) => records.get(key),
    entries: () => records.entries(),
    keys: () => records.keys(),
    size: records.size,
    put: async (key: string, value: ConversationRecord) => { calls.push(`put:${key}`); records.set(key, value) },
    delete: async (key: string) => { calls.push(`del:${key}`); return records.delete(key) },
    update: async (key: string, fn: (current: ConversationRecord) => ConversationRecord) => {
      const next = fn(records.get(key) as ConversationRecord)
      records.set(key, next)
      return next
    },
  }

  const posted: { content: string; channelId: string; token: string }[] = []
  const prompts: { content: string; channelId: string; components?: readonly DiscordActionRow[] }[] = []
  const cards: DiscordMessageBody[] = []
  const cleared: string[] = []
  const reactions: string[] = []
  const typed: string[] = []
  const waitResolvers: (() => void)[] = []
  const controller = new AbortController()
  const testContext = new Context().extend(ctx)
  const router = createConversationRouter({
    ctx: testContext,
    signal: controller.signal,
    settings: {
      ...SETTINGS,
      richMessages: options.richMessages ?? false,
      reactionStatus: options.reactionStatus ?? false,
      ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
      ...(options.idleReleaseMs === undefined ? {} : { idleReleaseMs: options.idleReleaseMs }),
      ...(options.conversationMaxAgeMs === undefined ? {} : { conversationMaxAgeMs: options.conversationMaxAgeMs }),
      ...(options.inboundDebounceMs === undefined ? {} : { inboundDebounceMs: options.inboundDebounceMs }),
      ...(options.typingIndicator === undefined ? {} : { typingIndicator: options.typingIndicator }),
      ...(options.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: options.approvalTimeoutMs }),
      ...(options.questionTimeoutMs === undefined ? {} : { questionTimeoutMs: options.questionTimeoutMs }),
      ...(options.answerers === undefined ? {} : { answerers: options.answerers }),
      ...(options.userLanes === undefined ? {} : { userLanes: options.userLanes }),
      ...(options.toolFilter === undefined ? {} : { toolFilter: options.toolFilter }),
      ...(options.modelSelection === undefined ? {} : { modelSelection: options.modelSelection }),
    },
    policy: {
      allowedUserIds: new Set(options.allowedUserIds ?? [USER]),
      allowedChannelIds: new Set([GUILD_CHANNEL]),
      guildRequireMention: options.guildRequireMention ?? false,
      botUserId: () => BOT_USER,
      laneUserIds: new Set(options.userLanes?.keys() ?? []),
    } satisfies RoutingPolicy,
    ...(options.commands === undefined ? {} : { commands: options.commands }),
    ...(options.statusDetails === undefined ? {} : { statusDetails: options.statusDetails }),
    table,
    postRich: async (body) => { cards.push(body) },
    ...(options.useDefaultClearPrompt ? {} : {
      clearPrompt: async (_channelId: string, messageId: string) => { cleared.push(messageId) },
    }),
    ...(options.useDefaultReact ? {} : {
      react: async (_message: DiscordInboundMessage, emoji: string, remove: boolean) => {
        reactions.push(`${remove ? 'remove' : 'add'}:${emoji}`)
      },
    }),
    ...(options.outboxStorage === undefined ? {} : { outboxTable: options.outboxStorage }),
    resolveToken: async () => {
      if (options.failToken) throw new Error('no token')
      return 'tok'
    },
    ...(options.rejectWait === true
      ? { wait: () => Promise.reject(new Error('listener gone')) }
      : options.manualWait === true
        ? { wait: () => new Promise<void>((resolve) => { waitResolvers.push(resolve) }) }
        : {}),
    ...(options.useDefaultPost ? {} : {
      post: async (content: string, channelId: string, token: string) => {
        calls.push('post')
        if (options.failPost) throw new Error('post failed')
        posted.push({ content, channelId, token })
      },
    }),
    ...(options.useDefaultPrompt === true ? {} : {
      prompt: async (
        content: string, channelId: string, _token: string, _signal: AbortSignal, components?: readonly DiscordActionRow[],
      ) => {
        calls.push('prompt')
        if (options.failPrompt) throw new Error('prompt refused')
        prompts.push({ content, channelId, ...(components === undefined ? {} : { components }) })
        const ordinal = prompts.length
        await options.promptBarrier
        if (options.promptResult !== undefined) return await options.promptResult(ordinal)
        return options.promptId ?? 'prompt-1'
      },
    }),
    ...(options.slowType === true ? {
      type: (_channelId: string, _token: string, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
        calls.push('type')
        signal.addEventListener('abort', () => { reject(new Error('typing request aborted')) }, { once: true })
      }),
    } : {
      type: async (channelId: string) => {
        calls.push('type')
        if (options.failType) throw new Error('typing refused')
        typed.push(channelId)
      },
    }),
  })
  return {
    router, calls, selections, posted, cards, cleared, reactions, prompts, typed, events, agent, handle, controller,
    table, registeredCommands, warnings,
    waitResolvers,
    emitEvent: (event: string, payload: Record<string, unknown>) => {
      for (const handler of [...(eventHandlers.get(event) ?? [])]) {
        handler(payload, () => Promise.reject(new Error('next called on a plain event')))
      }
    },
    ctx: testContext,
    releaseIdle: () => { idleResolve() },
    emitStatus: (liveAgent: unknown, status: Agent['status']) => {
      if (liveAgent === agent) agent.status = status
      for (const handler of [...(eventHandlers.get('agent/status') ?? [])]) {
        handler({ agent: liveAgent, status }, async () => undefined as never)
      }
    },
    emitWaterfall: (event: string, payload: Record<string, unknown>, next?: () => Promise<never>) => {
      const handler = (eventHandlers.get(event) ?? []).slice(-1)[0]
      if (handler === undefined) throw new Error(`no listener registered for ${event}`)
      return handler(payload, next ?? (async () => 'delegated' as never))
    },
  }
}

/** Let queued turns run to completion. */
export async function drain(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) await new Promise(resolve => setTimeout(resolve, 2))
}
