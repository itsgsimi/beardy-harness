import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { assertConfig, resolveBotToken, startListener } from '../src/index.ts'
import type { GatewayConnector, ResolvedConfig } from '../src/index.ts'
import type { ConversationRouter } from '../src/conversation.ts'
import type { DiscordGatewayOptions } from '../src/gateway.ts'
import type { DiscordInboundMessage, GatewayStatus } from '../src/types.ts'

const USER = '138391763999129600'
const CHANNEL = '1472404859679670455'

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    tokenEnv: 'DSH_DISCORD_BOT_TOKEN',
    allowedUserIds: [USER],
    allowedChannelIds: [],
    workspacePath: '/workspace',
    agentPreset: 'beardy',
    permissionPreset: 'danger-full-access',
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
    enabled: true,
    ...overrides,
  }
}

describe('assertConfig', () => {
  it('accepts a complete configuration', () => {
    expect(() => { assertConfig(config()) }).not.toThrow()
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

  it('accepts a zero debounce window, which answers every message at once', () => {
    expect(() => { assertConfig(config({ inboundDebounceMs: 0 })) }).not.toThrow()
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
      resolve: async (name: string) => {
        if (options.unknownPreset) throw new Error(`agent preset "${name}" is not registered`)
        return { id: name }
      },
    },
    permissionPresets: { resolve: () => ({}) },
  }
  return { ctx: ctx as unknown as Context, logger }
}

const handled = vi.fn()
const ROUTER = { handle: handled, dispose: vi.fn() } as unknown as ConversationRouter

describe('startListener', () => {
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
      options.onReady?.('bot-user-1')
      options.onMessage(message)
    }
    const onReady = vi.fn()
    await startListener(ctx, config(), ROUTER, new AbortController().signal, connect, onReady)
    expect(captured?.token).toBe('secret-token')
    expect(captured?.intents).toBeGreaterThan(0)
    expect(captured?.reconnectDelayMs).toBe(1_000)
    expect(handled).toHaveBeenCalledTimes(1)
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
