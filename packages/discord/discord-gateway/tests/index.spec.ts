import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { HealthStatus } from '@deepseek-ai/dsh-health'
import type { OutboxRecord } from '../src/domain.ts'
import { apply, assertConfig, Config, currentHealthStatusLines, healthStatusLines, laneCommandCatalog, resolveBotToken, resolvePresetScopes, startListener, toSettings } from '../src/index.ts'
import type { GatewayConnector, ResolvedConfig } from '../src/index.ts'
import type { ConversationRouter } from '../src/conversation.ts'
import type { DiscordGatewayOptions } from '../src/gateway.ts'
import type { DiscordInboundMessage, GatewayStatus } from '../src/types.ts'
import { record } from './support.ts'

const USER = '138391763999129600'
const CHANNEL = '1472404859679670455'

describe('health status lines', () => {
  it('shows configured probe states and the last cron failure without exposing endpoint details', () => {
    expect(healthStatusLines(undefined)).toEqual([])
    const snapshot: ReturnType<HealthStatus['snapshot']> = { probes: [] }
    const status: HealthStatus = { snapshot: () => snapshot }
    expect(healthStatusLines(status)).toEqual(['Probes: none configured.', 'Last cron failure: none.'])
    const observed: HealthStatus = { ...status, snapshot: () => ({ probes: [
      { name: 'main', state: 'down', cause: 'HTTP 503' }, { name: 'local', state: 'healthy' },
    ], lastCronFailure: { jobName: 'brief', sessionId: 's1', code: 'TRANSPORT', nextFireAt: '2026-09-28T07:00:00.000Z' } }) }
    expect(healthStatusLines(observed)).toEqual([
      'Probes: main down (HTTP 503), local healthy',
      'Last cron failure: brief, Session s1, TRANSPORT, next 2026-09-28T07:00:00.000Z.',
    ])
    const noNext: HealthStatus = { ...status, snapshot: () => ({ probes: [],
      lastCronFailure: { jobName: 'brief', sessionId: 's2', code: 'TIMED-OUT' } }) }
    expect(healthStatusLines(noNext)[1]).toBe('Last cron failure: brief, Session s2, TIMED-OUT, next none.')
    const paused: HealthStatus = { ...status, snapshot: () => ({ probes: [
      { name: 'ornith', state: 'paused', pausedBy: 'Goran', pausedAt: '2026-09-27T18:00:00.000Z' },
    ] }) }
    expect(healthStatusLines(paused)[0]).toBe('Probes: ornith paused (unloaded by Goran at 2026-09-27T18:00:00.000Z)')
  })

  it('reads the current health snapshot for each status command', () => {
    const ctx = new Context()
    let state: 'healthy' | 'down' = 'healthy'
    ctx.provide('healthStatus', { snapshot: () => ({ probes: [{ name: 'main', state }] }) } as never)
    expect(currentHealthStatusLines(ctx)).toContain('Probes: main healthy')
    state = 'down'
    expect(currentHealthStatusLines(ctx)).toContain('Probes: main down')
    ctx.provide('localModels', {
      unloadedForRoute: () => undefined,
      unloadedForHealthUrl: () => undefined,
      backends: () => [{ name: 'ornith', routes: ['subagent'],
        intent: { by: 'Goran', at: '2026-09-27T18:00:00.000Z' } },
      { name: 'qwen-strix', routes: ['strix'] }],
    })
    expect(currentHealthStatusLines(ctx)).toContain('Local models: ornith unloaded by Goran at 2026-09-27T18:00:00.000Z')
  })
})

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    excludedPresetCommands: ['export'], richMessages: false, accentColor: 0x5865f2, reactionStatus: false,
    replyRequestTimeoutMs: 15000, replyMaxRetries: 2, replyMaxRetryWaitMs: 30000, replyMaxChunksPerCall: 10,
    interactionMaxPending: 100, interactionReceiptLimit: 1000, nativeCommands: false, commandSyncRetryMs: 30000,
    tokenEnv: 'DSH_DISCORD_BOT_TOKEN',
    allowedUserIds: [USER],
    allowedChannelIds: [],
    workspacePath: '/workspace',
    agentPreset: 'beardy',
    permissionPreset: 'danger-full-access',
    userLanes: {},
    titlePrefix: 'Discord',
    maxInputChars: 8_000,
    turnTimeoutMs: 600_000,
    reconnectDelayMs: 1_000,
    maxReconnectDelayMs: 30_000,
    idleReleaseMs: 900_000,
    conversationMaxAgeMs: 86_400_000,
    inboundDebounceMs: 3_000,
    guildRequireMention: true,
    typingIndicator: true,
    approvalTimeoutMs: 60_000,
    questionTimeoutMs: 60_000,
    answerers: ['reaction', 'text'],
    enabled: true,
    outboxMaxPending: 100, outboxMaxChars: 20000, outboxRetryMs: 1000,
    outboxMaxRetryMs: 60000, outboxMaxReceipts: 1000, wakeRetryMs: 30000,
    ...overrides,
  }
}

describe('assertConfig', () => {
  it('parses an optional gateway choice with its effort', () => {
    const parsed = Config(config({ modelSelection: {
      provider: 'local', model: 'coder', reasoningEffort: 'medium',
    } }))
    expect(parsed.modelSelection).toEqual({ provider: 'local', model: 'coder', reasoningEffort: 'medium' })
  })

  it('mounts with an explicit selection before the adapter registers', async () => {
    const ctx = new Context()
    await expect(apply(ctx, config({ enabled: false, modelSelection: {
      provider: 'local', model: 'coder', reasoningEffort: 'medium',
    } }))).resolves.toBeUndefined()
  })

  it('mounts disabled without requiring an LLM registry when no choice is configured', async () => {
    await expect(apply(new Context(), config({ enabled: false }))).resolves.toBeUndefined()
  })

  it('accepts a complete configuration', () => {
    expect(() => { assertConfig(config()) }).not.toThrow()
  })

  it('rejects an initial outbox retry above its ceiling', () => {
    expect(() => { assertConfig(config({ outboxRetryMs: 10000, outboxMaxRetryMs: 1000 })) })
      .toThrow('outboxRetryMs must not exceed outboxMaxRetryMs')
  })

  it('rejects an allowlist that would answer nobody', () => {
    expect(() => { assertConfig(config({ allowedUserIds: [] })) })
      .toThrow('allowedUserIds must name at least one Discord user')
  })

  it('rejects a user id that is not a snowflake', () => {
    expect(() => { assertConfig(config({ allowedUserIds: ['goran'] })) })
      .toThrow('allowedUserIds must each be a Discord snowflake of 17 to 20 digits, got "goran"')
  })

  it('rejects a channel id that is not a snowflake', () => {
    expect(() => { assertConfig(config({ allowedChannelIds: ['general'] })) })
      .toThrow('allowedChannelIds must each be a Discord snowflake of 17 to 20 digits, got "general"')
  })

  it('rejects a workspace path that is not absolute', () => {
    expect(() => { assertConfig(config({ workspacePath: 'workspace' })) })
      .toThrow('workspacePath must be absolute, got "workspace"')
  })

  it('rejects a timeout that is not a whole number of milliseconds', () => {
    expect(() => { assertConfig(config({ turnTimeoutMs: 1_000.5 })) })
      .toThrow('turnTimeoutMs must be a positive safe integer')
  })

  it('rejects a reconnect delay above its own cap', () => {
    expect(() => { assertConfig(config({ reconnectDelayMs: 5_000, maxReconnectDelayMs: 1_000 })) })
      .toThrow('reconnectDelayMs must not exceed maxReconnectDelayMs')
  })

  it('rejects an idle release that is not shorter than the conversation expiry', () => {
    expect(() => { assertConfig(config({ idleReleaseMs: 86_400_000 })) })
      .toThrow('idleReleaseMs must be shorter than conversationMaxAgeMs')
  })

  it('rejects an empty or unknown answerers list', () => {
    expect(() => { assertConfig(config({ answerers: [] })) }).toThrow(/answerers must name at least one/)
    expect(() => { assertConfig(config({ answerers: ['reaction', 'buttons'] })) })
      .toThrow(/must each be "reaction", "text", or "component", got "buttons"/)
  })

  it('accepts a zero debounce window, which answers every message at once', () => {
    expect(() => { assertConfig(config({ inboundDebounceMs: 0 })) }).not.toThrow()
  })

  it('validates lane ownership, workspace paths, and command exclusions', () => {
    const lane = { workspacePath: '/restricted', agentPreset: 'restricted', permissionPreset: 'read-only', excludedPresetCommands: [] }
    expect(() => { assertConfig(config({ userLanes: { [USER]: lane } })) }).not.toThrow()
    expect(() => { assertConfig(config({ userLanes: { ['138391763999129601']: lane } })) })
      .toThrow('allowedUserIds does not admit')
    expect(() => { assertConfig(config({ userLanes: { [USER]: { ...lane, workspacePath: 'relative' } } })) })
      .toThrow('workspacePath must be absolute')
    expect(() => { assertConfig(config({ userLanes: { [USER]: { ...lane, excludedPresetCommands: ['help'] } } })) })
      .toThrow('must name preset commands, not gateway controls')
    expect(() => { assertConfig(config({ excludedPresetCommands: ['Bad Command'] })) })
      .toThrow('must name preset commands, not gateway controls')
  })

  it('requires an allow or deny list when a lane tool filter is configured', () => {
    const lane = { workspacePath: '/restricted', agentPreset: 'restricted', permissionPreset: 'read-only', excludedPresetCommands: [] }
    expect(() => { assertConfig(config({ toolFilter: {} })) }).toThrow('toolFilter is configured but names neither')
    expect(() => { assertConfig(config({ userLanes: { [USER]: { ...lane, toolFilter: {} } } })) })
      .toThrow(`userLanes.${USER}.toolFilter is configured but names neither`)
    expect(() => { assertConfig(config({ toolFilter: { allow: [] }, userLanes: { [USER]: { ...lane, toolFilter: { deny: [] } } } })) })
      .not.toThrow()
  })

  it('keeps omitted tool restrictions absent during configuration materialization', () => {
    const base = { tokenEnv: 'BOT_TOKEN', allowedUserIds: [USER], workspacePath: '/workspace',
      agentPreset: 'beardy', permissionPreset: 'danger-full-access' }
    expect(Config(base).toolFilter).toBeUndefined()
    expect(Config({ ...base, toolFilter: { deny: ['shell'] } }).toolFilter)
      .toEqual({ deny: ['shell'] })
    expect(Config({ ...base, toolFilter: { allow: ['read_file'] } }).toolFilter)
      .toEqual({ allow: ['read_file'] })
  })

  it('rejects values that bypass the schema bounds in a direct config call', () => {
    expect(() => { assertConfig(config({ inboundDebounceMs: -1 })) })
      .toThrow('inboundDebounceMs must be a non-negative safe integer')
    expect(() => { assertConfig(config({ accentColor: 0x1000000 })) })
      .toThrow('accentColor must be a 24-bit RGB color')
  })
})

describe('lane settings and command catalogs', () => {
  it('copies lane filters and adds user exclusions to the shared exclusions', () => {
    const lane = { workspacePath: '/restricted', agentPreset: 'restricted', permissionPreset: 'read-only',
      excludedPresetCommands: ['export', 'danger'], toolFilter: { deny: ['shell'] } }
    const { settings, policy } = toSettings(config({ toolFilter: { allow: ['read_file'] }, userLanes: { [USER]: lane } }), () => 'bot')
    expect(settings.toolFilter).toEqual({ allow: ['read_file'] })
    expect(settings.userLanes.get(USER)).toEqual({ userId: USER, workspacePath: '/restricted',
      agentPreset: 'restricted', permissionPreset: 'read-only', excludedPresetCommands: ['export', 'danger'],
      toolFilter: { deny: ['shell'] } })
    expect(policy.laneUserIds.has(USER)).toBe(true)
    expect(toSettings(config(), () => 'bot').settings.toolFilter).toBeUndefined()
  })

  it('leases each preset once and rejects a catalog whose preset scope was not resolved', async () => {
    const acquireScope = vi.fn(async (name: string) => ({ key: name, [Symbol.asyncDispose]: async () => {} }))
    const listForScope = vi.fn(() => [{ name: 'inspect', description: 'Inspect' }, { name: 'danger', description: 'Danger' }])
    const ctx = new Context().extend({ agentPresets: { acquireScope }, commands: { listForScope } })
    const lane = { workspacePath: '/restricted', agentPreset: 'restricted', permissionPreset: 'read-only', excludedPresetCommands: ['danger'] }
    const scopes = await resolvePresetScopes(ctx, config({ userLanes: { [USER]: lane, ['138391763999129601']: lane } }))
    expect(acquireScope.mock.calls).toEqual([['beardy'], ['restricted']])
    expect(laneCommandCatalog(ctx, scopes)({ userId: USER, ...lane }).map(command => command.name))
      .toEqual(expect.arrayContaining(['help', 'inspect']))
    expect(laneCommandCatalog(ctx, scopes)({ userId: USER, ...lane }).map(command => command.name)).not.toContain('danger')
    expect(() => { laneCommandCatalog(ctx, new Map())({ userId: USER, ...lane }) })
      .toThrow('has no resolved standing scope')
    await scopes[Symbol.asyncDispose]()
  })

  it('releases earlier preset scopes when a later preset cannot be acquired', async () => {
    const release = vi.fn(async () => {})
    const acquireScope = vi.fn(async (name: string) => {
      if (name === 'restricted') throw new Error('preset unavailable')
      return { key: name, [Symbol.asyncDispose]: release }
    })
    const ctx = new Context().extend({ agentPresets: { acquireScope } })
    const lane = { workspacePath: '/restricted', agentPreset: 'restricted', permissionPreset: 'read-only', excludedPresetCommands: [] }
    await expect(resolvePresetScopes(ctx, config({ userLanes: { [USER]: lane } })))
      .rejects.toThrow('preset unavailable')
    expect(release).toHaveBeenCalledOnce()
  })
})

/** Context carrying only what the listener resolves before it dials out. */
function contextStub(options: { token?: string; unknownPreset?: boolean } = {}) {
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
  const ctx = {
    logger,
    credentials: {
      resolve: async (ref: unknown) => (options.token === undefined ? undefined : { value: options.token, ref }),
    },
    agentPresets: {
      acquireScope: async (name: string) => {
        if (options.unknownPreset) throw new Error(`agent preset "${name}" is not registered`)
        return { key: {}, [Symbol.asyncDispose]: async () => {} }
      },
      resolve: async (name: string) => {
        if (options.unknownPreset) throw new Error(`agent preset "${name}" is not registered`)
        return { id: name }
      },
    },
    permissionPresets: { resolve: () => ({}) },
  }
  return { ctx: new Context().extend(ctx), logger }
}

const handled = vi.fn()
const reacted = vi.fn()
const ROUTER: ConversationRouter = {
  handle: handled, handleReaction: reacted, dispose: vi.fn(async () => {}),
  recover: async () => {}, deliver: async () => {},
  execute: async () => ({ kind: 'success', text: '' }), component: async () => '',
}

describe('startListener', () => {
  it('cancels a startup reminder read before waiting for recovery to finish during disposal', async () => {
    const { ctx } = contextStub()
    const entered = Promise.withResolvers<undefined>()
    const readClosed = vi.fn(async () => {})
    const domainClosed = vi.fn(async () => {})
    const cleanup: (() => unknown)[] = []
    const routes = new Map([[CHANNEL, record({ deliveredThrough: 0 })]])
    const notices = new Map<string, OutboxRecord>()
    const outbox = { get: (key: string) => notices.get(key), entries: () => notices.entries(),
      put: async (key: string, value: OutboxRecord) => { notices.set(key, value) },
      delete: async (key: string) => { notices.delete(key) } }
    let healthTransition: ((transition: { id: string; channelId: string; text: string }) => Promise<true>) | undefined
    let reads = 0
    const owner = new Context().extend({
      logger: ctx.logger,
      credentials: ctx.credentials,
      agentPresets: ctx.agentPresets,
      permissionPresets: ctx.permissionPresets,
      on: (event: string, handler: (transition: { id: string; channelId: string; text: string }) => Promise<true>) => {
        if (event === 'health/transition') healthTransition = handler
        return () => {}
      },
      effect: (effect: () => (() => unknown), label: string) => {
        const dispose = effect()
        if (label === 'discord-gateway listener') cleanup.push(dispose)
        return dispose
      },
      storageDomain: { open: async () => ({
        table: (name: string) => name === 'conversations' ? routes : outbox,
        close: domainClosed,
      }) },
      sessionPersistence: { open: async (_id: string, _mode: string, options: { signal: AbortSignal }) => ({
        inheritedEventCount: 0,
        read: async () => {
          if (++reads === 1) return []
          entered.resolve(undefined)
          return await new Promise<never>((_resolve, reject) => {
            options.signal.addEventListener('abort', () => { reject(new Error('read aborted')) }, { once: true })
          })
        },
        close: readClosed,
      }) },
    })
    const resolveModelInfo = vi.fn(async () => ({
      provider: 'local', id: 'coder', name: 'Coder', reasoning: { efforts: [{ id: 'medium', name: 'Medium' }] },
    }))
    owner.provide('llm', { resolveModelInfo } as never)
    await apply(owner, config({ modelSelection: {
      provider: 'local', model: 'coder', reasoningEffort: 'medium',
    } }))
    expect(resolveModelInfo).not.toHaveBeenCalled()
    await entered.promise
    expect(healthTransition).toBeDefined()
    await healthTransition?.({ id: 'health:transition-1', channelId: CHANNEL, text: 'Probe main: down.' })
    expect(notices.get('health:transition-1')).toMatchObject({ channelId: CHANNEL, chunks: ['Probe main: down.'] })
    await cleanup[0]?.()
    expect(readClosed).toHaveBeenCalledTimes(2)
    expect(domainClosed).toHaveBeenCalledTimes(1)
  })

  it('connects with the resolved token and routes gateway events', async () => {
    const { ctx, logger } = contextStub({ token: 'secret-token' })
    let captured: DiscordGatewayOptions | undefined
    const connect: GatewayConnector = async (options) => {
      captured = options
      const message: DiscordInboundMessage = {
        id: 'm1', channelId: CHANNEL, guildId: '', authorId: USER, bot: false, channelType: 1,
        content: 'hi', mentionedUserIds: [], replyToAuthorId: '',
      }
      const statuses: GatewayStatus[] = [
        { kind: 'connecting' }, { kind: 'ready' }, { kind: 'disconnected', reason: 'socket closed' },
      ]
      for (const status of statuses) options.onStatus?.(status)
      options.onReady?.('bot-user-1', 'bot-application-1')
      options.onMessage(message)
      options.onReaction?.({ userId: USER, channelId: CHANNEL, messageId: 'm1', emojiName: '✅' })
    }
    const onReady = vi.fn()
    await startListener(ctx, config(), ROUTER, new AbortController().signal, connect, onReady)
    expect(captured?.token).toBe('secret-token')
    expect(captured?.intents).toBeGreaterThan(0)
    expect(captured?.reconnectDelayMs).toBe(1_000)
    expect(handled).toHaveBeenCalledTimes(1)
    expect(reacted).toHaveBeenCalledWith({ userId: USER, channelId: CHANNEL, messageId: 'm1', emojiName: '✅' })
    expect(onReady).toHaveBeenCalledWith('bot-user-1')
    expect(logger.info).toHaveBeenCalledWith('discord-gateway: connected; messages from allowed users start conversations')
    expect(logger.warn).toHaveBeenCalledWith('discord-gateway: socket closed; reconnecting')
  })

  it('reports a missing bot token and never dials out', async () => {
    const { ctx, logger } = contextStub()
    const connect = vi.fn<GatewayConnector>(async () => {})
    await startListener(ctx, config(), ROUTER, new AbortController().signal, connect)
    expect(connect).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('no bot token is configured for'))
  })

  it('reports an agent preset the host does not have', async () => {
    const { ctx, logger } = contextStub({ token: 'secret-token', unknownPreset: true })
    const connect = vi.fn<GatewayConnector>(async () => {})
    await startListener(ctx, config(), ROUTER, new AbortController().signal, connect)
    expect(connect).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('agent preset "beardy" is not registered'))
  })

  it('stays silent when the listener was disposed while connecting', async () => {
    const { ctx, logger } = contextStub({ token: 'secret-token' })
    const controller = new AbortController()
    await startListener(ctx, config(), ROUTER, controller.signal, async () => {
      controller.abort(new Error('listener disposed'))
      throw new Error('socket failed mid-disposal')
    })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('resolves the bot token through the credential provider', async () => {
    const { ctx } = contextStub({ token: 'secret-token' })
    await expect(resolveBotToken(ctx, 'DSH_DISCORD_BOT_TOKEN')).resolves.toBe('secret-token')
  })

  it('refuses to name a destination without a bot token', async () => {
    const { ctx } = contextStub()
    await expect(resolveBotToken(ctx, 'DSH_DISCORD_BOT_TOKEN'))
      .rejects.toThrow('no bot token is configured for "DSH_DISCORD_BOT_TOKEN"')
  })

  it('uses the real gateway client when no connector is given', async () => {
    class StubSocket {
      static opened: StubSocket[] = []
      private readonly handlers = new Map<string, ((event: unknown) => void)[]>()

      constructor(readonly url: string) {
        StubSocket.opened.push(this)
      }

      send(_data: string): void {}
      close(): void { this.fire('close', { code: 1000 }) }
      addEventListener(event: string, handler: (event: unknown) => void): void {
        this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
      }

      removeEventListener(event: string, handler: (event: unknown) => void): void {
        this.handlers.set(event, (this.handlers.get(event) ?? []).filter(entry => entry !== handler))
      }

      fire(event: string, payload: unknown): void {
        for (const handler of this.handlers.get(event) ?? []) handler(payload)
      }
    }
    vi.stubGlobal('WebSocket', StubSocket)
    try {
      const { ctx } = contextStub({ token: 'secret-token' })
      const controller = new AbortController()
      setTimeout(() => { controller.abort(new Error('test over')) }, 5)
      await startListener(ctx, config(), ROUTER, controller.signal)
      expect(StubSocket.opened[0]?.url).toContain('gateway.discord.gg')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
