/**
 * Shared fake of everything the conversation router touches: services, the durable record table,
 * the delivery seams, and the event capture needed to drive proactive delivery. Not a spec file.
 */

import { vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { createConversationRouter } from '../src/conversation.ts'
import type { RoutingPolicy } from '../src/conversation.ts'
import type { ConversationRecord } from '../src/domain.ts'
import type { DiscordInboundMessage, GatewaySettings } from '../src/types.ts'

export const USER = '138391763999129600'
export const CHANNEL = '1472404859679670455'
export const GUILD_CHANNEL = '1478276183543119914'
export const BOT_USER = '111111111111111111'

/** Settings that keep every timer in the router inert unless a test arms it deliberately. */
export const SETTINGS: GatewaySettings = {
  workspacePath: '/workspace',
  agentPreset: 'beardy',
  permissionPreset: 'danger-full-access',
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
  /** Leave out the prompt seam so the router's Discord transport runs for prompts. */
  readonly useDefaultPrompt?: boolean
  /** Reply forms the router accepts; defaults to both. */
  readonly answerers?: readonly ('reaction' | 'text')[]
}

/** Context carrying the services the router touches, recording every call it makes. */
export function harness(options: HarnessOptions = {}) {
  const calls: string[] = []
  const warnings: string[] = []
  const events: SessionEvent[] = []
  const eventHandlers = new Map<string, ((payload: Record<string, unknown>, next: () => Promise<never>) => unknown)[]>()
  const registeredCommands = new Map<string, { name: string; description: string; handler: (invocation: { agent: unknown }) => unknown }>()
  let idleResolve: () => void = () => {}
  const agent = {
    session: {
      get seq(): number { return events.length },
      ownEvents: () => events,
    },
    followup(message: { content: readonly { text?: string }[] }) {
      calls.push(`followup:${message.content[0]?.text ?? ''}`)
      if (options.replyText !== undefined) {
        events.push({
          seq: events.length,
          type: 'assistant/message',
          data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: options.replyText }] } },
        } as unknown as SessionEvent)
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
    agent,
    dispose: vi.fn(async () => { calls.push('dispose') }),
  }
  const agentCtx = {
    commands: {
      register: (definition: { name: string; description: string; handler: (invocation: { agent: unknown }) => unknown }) => {
        calls.push(`cmd:${definition.name}`)
        registeredCommands.set(definition.name, definition)
        return () => { registeredCommands.delete(definition.name) }
      },
    },
  }
  const ctx = {
    logger: { info: vi.fn(), warn: (message: string) => { warnings.push(message) }, error: vi.fn(), debug: vi.fn() },
    effect: (fn: () => (() => unknown) | undefined) => fn(),
    on: (event: string, handler: (payload: Record<string, unknown>, next: () => Promise<never>) => unknown) => {
      const list = eventHandlers.get(event) ?? []
      list.push(handler)
      eventHandlers.set(event, list)
      return () => { list.splice(list.indexOf(handler), 1) }
    },
    permissionPresets: {
      resolve: (name: string) => { calls.push(`permission-resolve:${name}`); return {} },
      set: (_session: unknown, name: string) => { calls.push(`permission-set:${name}`) },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    agentPresets: {
      resolve: async (name: string) => { calls.push(`preset-resolve:${name}`); return { id: name } },
      standingKeyFor: async (name: string) => { calls.push(`standing:${name}`); return {} },
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
      create: async (createOptions: { setup?: (ctx: unknown) => Promise<void> }) => {
        calls.push('agent-create')
        await createOptions.setup?.(agentCtx)
        return handle
      },
      resume: async (resumeOptions: { resumeSessionId: string; setup?: (ctx: unknown) => Promise<void> }) => {
        calls.push(`agent-resume:${resumeOptions.resumeSessionId}`)
        if (options.resumeError === 'not-found') {
          throw new SessionPersistenceNotFoundError(resumeOptions.resumeSessionId as never)
        }
        if (options.resumeError === 'other') throw new Error('persistence backend down')
        await resumeOptions.setup?.(agentCtx)
        return handle
      },
    },
    commands: {
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
  const prompts: { content: string; channelId: string }[] = []
  const typed: string[] = []
  const waitResolvers: (() => void)[] = []
  const controller = new AbortController()
  const router = createConversationRouter({
    ctx: ctx as unknown as Context,
    signal: controller.signal,
    settings: {
      ...SETTINGS,
      ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
      ...(options.idleReleaseMs === undefined ? {} : { idleReleaseMs: options.idleReleaseMs }),
      ...(options.conversationMaxAgeMs === undefined ? {} : { conversationMaxAgeMs: options.conversationMaxAgeMs }),
      ...(options.inboundDebounceMs === undefined ? {} : { inboundDebounceMs: options.inboundDebounceMs }),
      ...(options.typingIndicator === undefined ? {} : { typingIndicator: options.typingIndicator }),
      ...(options.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: options.approvalTimeoutMs }),
      ...(options.questionTimeoutMs === undefined ? {} : { questionTimeoutMs: options.questionTimeoutMs }),
      ...(options.answerers === undefined ? {} : { answerers: options.answerers }),
    },
    policy: {
      allowedUserIds: new Set([USER]),
      allowedChannelIds: new Set([GUILD_CHANNEL]),
      guildRequireMention: options.guildRequireMention ?? false,
      botUserId: () => BOT_USER,
    } satisfies RoutingPolicy,
    table,
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
      prompt: async (content: string, channelId: string) => {
        calls.push('prompt')
        if (options.failPrompt) throw new Error('prompt refused')
        prompts.push({ content, channelId })
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
    router, calls, posted, prompts, typed, events, agent, handle, controller, table, registeredCommands, warnings,
    waitResolvers,
    ctx: ctx as unknown as Context,
    releaseIdle: () => { idleResolve() },
    emitStatus: (liveAgent: unknown, status: string) => {
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
