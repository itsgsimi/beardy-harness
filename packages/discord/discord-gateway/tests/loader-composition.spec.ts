import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as DiscordGateway from '../src/index.ts'

const USER = '138391763999129600'
const CHANNEL = '1472404859679670455'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllGlobals()
})

/** One assistant answer per turn, so the mounted router has something to post back. */
interface FixtureAgentRecord {
  readonly created: string[]
  readonly followedUp: string[]
}

/** Services the listener creates Sessions through, provided as inert stubs. */
function fixtureDependencies(token: string | undefined, record: FixtureAgentRecord): unknown {
  return {
    name: 'fixture-dependencies',
    apply(ctx: Context) {
      ctx.provide('credentials' as never, {
        resolve: async () => (token === undefined ? undefined : { value: token, source: 'env' }),
      } as never)
      const sessions = new Map<string, Record<string, unknown>[]>()
      const fakeHandle = (sessionId: string) => {
        const events = sessions.get(sessionId) ?? []
        sessions.set(sessionId, events)
        return {
          agent: {
            session: { get seq(): number { return events.length }, ownEvents: () => events },
            followup: (message: { source?: { kind?: string } }) => {
              record.followedUp.push(message.source?.kind ?? '')
              events.push({
                seq: events.length + 1,
                type: 'assistant/message',
                data: { message: { content: [{ type: 'text', text: 'Morning brief is ready.' }] } },
              })
            },
            whenIdle: async () => {},
          },
          dispose: async () => {},
        }
      }
      const compositionSetup = (options: { setup?: (agentCtx: unknown) => Promise<void> }) =>
        options.setup?.({ commands: { register: () => () => {} } })
      ctx.provide('agents' as never, {
        create: async (options: { sessionId: string; setup?: (agentCtx: unknown) => Promise<void> }) => {
          record.created.push(options.sessionId)
          await compositionSetup(options)
          return fakeHandle(options.sessionId)
        },
        resume: async (options: { resumeSessionId: string; setup?: (agentCtx: unknown) => Promise<void> }) => {
          record.followedUp.push(`resume:${options.resumeSessionId}`)
          await compositionSetup(options)
          return fakeHandle(options.resumeSessionId)
        },
      } as never)
      ctx.provide('commands' as never, {
        execute: async () => undefined,
        register: () => () => {},
      } as never)
      const conversations = new Map<string, Record<string, unknown>>()
      ctx.provide('storageDomain' as never, {
        open: async () => ({
          name: 'discord-gateway',
          table: () => ({
            get: (key: string) => conversations.get(key),
            entries: () => conversations.entries(),
            keys: () => conversations.keys(),
            size: conversations.size,
            put: async (key: string, value: Record<string, unknown>) => { conversations.set(key, value) },
            delete: async (key: string) => conversations.delete(key),
            update: async (key: string, fn: (current: never) => never) => {
              const next = fn(conversations.get(key) as never)
              conversations.set(key, next)
              return next
            },
          }),
          global: { get: () => ({}) },
          close: async () => {},
        }),
      } as never)
      ctx.provide('agentDefaultModel' as never, {
        currentSelection: () => ({ provider: 'fixture-provider', model: 'fixture-model' }),
      } as never)
      ctx.provide('agentPresets' as never, {
        resolve: async (name: string) => ({ id: name }),
        standingKeyFor: async () => ({}),
        mount: async () => {},
      } as never)
      ctx.provide('permissionPresets' as never, {
        resolve: () => ({}),
        set: () => {},
      } as never)
      ctx.provide('sessionTitle' as never, { rename: () => {} } as never)
      ctx.provide('workspaceRegistry' as never, {
        create: async (path: string) => ({
          path,
          attachSession: async () => {},
          detachSession: async () => {},
        }),
      } as never)
    },
  }
}

/** Boot a composition that mounts the real plugin over the stub services. */
async function boot(
  lines: readonly string[],
  token?: string,
  record: FixtureAgentRecord = { created: [], followedUp: [] },
): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-discord-gateway-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, ['- name: fixture-dependencies', ...lines, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['fixture-dependencies', fixtureDependencies(token, record)],
    ['@deepseek-ai/dsh-discord-gateway', DiscordGateway],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

/** Gateway rows every case shares; only `enabled` and the allowlists vary. */
const GATEWAY_ROWS = [
  "- name: '@deepseek-ai/dsh-discord-gateway'",
  '  config:',
  '    tokenEnv: DSH_DISCORD_BOT_TOKEN',
  `    workspacePath: ${process.cwd()}`,
  '    agentPreset: beardy',
  '    permissionPreset: danger-full-access',
  '    inboundDebounceMs: 0',
]

/** Loader entries that were requested but never mounted. */
function unloaded(ctx: Context): string[] {
  return [...ctx.loader.entries()]
    .filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)
}

describe('discord-gateway real Loader composition', () => {
  it('mounts with the listener off and dials nothing out', { timeout: 60_000 }, async () => {
    const sockets: string[] = []
    vi.stubGlobal('WebSocket', function Fake(url: string) {
      sockets.push(url)
      return {} as WebSocket
    })
    const ctx = await boot([
      ...GATEWAY_ROWS,
      `    allowedUserIds: ['${USER}']`,
      '    enabled: false',
    ], 'fixture-token')
    expect(unloaded(ctx)).toEqual([])
    expect(sockets).toEqual([])
  })

  it('refuses to connect when the bot token is not configured', { timeout: 60_000 }, async () => {
    const sockets: string[] = []
    vi.stubGlobal('WebSocket', function Fake(url: string) {
      sockets.push(url)
      return {} as WebSocket
    })
    const ctx = await boot([
      ...GATEWAY_ROWS,
      `    allowedUserIds: ['${USER}']`,
    ])
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(unloaded(ctx)).toEqual([])
    expect(sockets).toEqual([])
  })

  it('refuses a configuration that would listen for nobody', { timeout: 60_000 }, async () => {
    await expect(boot([
      ...GATEWAY_ROWS,
      '    allowedUserIds: []',
      '    enabled: false',
    ], 'fixture-token')).rejects.toThrow('allowedUserIds must name at least one Discord user')
  })

  it('refuses a workspace path that is not absolute', { timeout: 60_000 }, async () => {
    await expect(boot([
      "- name: '@deepseek-ai/dsh-discord-gateway'",
      '  config:',
      '    tokenEnv: DSH_DISCORD_BOT_TOKEN',
      "    workspacePath: './relative-workspace'",
      '    agentPreset: beardy',
      '    permissionPreset: danger-full-access',
      `    allowedUserIds: ['${USER}']`,
      '    enabled: false',
    ], 'fixture-token')).rejects.toThrow('workspacePath must be absolute')
  })

  it('answers a direct message end to end over a stubbed gateway', { timeout: 60_000 }, async () => {
    const record: FixtureAgentRecord = { created: [], followedUp: [] }
    const posts: string[] = []
    class StubSocket {
      static instance: StubSocket | undefined
      private readonly handlers = new Map<string, ((event: unknown) => void)[]>()

      constructor(_url: string) { StubSocket.instance = this }
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
    vi.stubGlobal('fetch', async (_input: string | URL, init?: { body?: string }) => {
      posts.push(init?.body ?? '')
      return new Response(JSON.stringify({ id: 'm9' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    })
    try {
      const ctx = await boot([
        ...GATEWAY_ROWS,
        `    allowedUserIds: ['${USER}']`,
        "    allowedChannelIds: ['12345678901234567']",
      ], 'fixture-token', record)
      for (let round = 0; round < 10 && StubSocket.instance === undefined; round += 1) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(StubSocket.instance).toBeDefined()
      StubSocket.instance?.fire('message', {
        data: JSON.stringify({ op: 0, t: 'READY', s: 2, d: { application: { id: 'bot-9' } } }),
      })
      StubSocket.instance?.fire('message', {
        data: JSON.stringify({
          op: 0,
          t: 'MESSAGE_CREATE',
          s: 3,
          d: { id: 'm1', channel_id: CHANNEL, channel_type: 1, author: { id: USER }, content: 'good morning' },
        }),
      })
      for (let round = 0; round < 20 && posts.length === 0; round += 1) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(record.created).toHaveLength(1)
      expect(record.followedUp).toEqual(['discord'])
      expect(posts.some(body => body.includes('Morning brief is ready.'))).toBe(true)
      // A guild message that mentions the bot user from READY opens its own channel conversation.
      StubSocket.instance?.fire('message', {
        data: JSON.stringify({
          op: 0,
          t: 'MESSAGE_CREATE',
          s: 4,
          d: {
            id: 'm2', channel_id: '12345678901234567', channel_type: 0, guild_id: 'g1',
            author: { id: USER }, content: 'beardy-bot hello', mentions: [{ id: 'bot-9' }],
          },
        }),
      })
      for (let round = 0; round < 20 && record.created.length < 2; round += 1) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(record.created).toHaveLength(2)
      expect(unloaded(ctx)).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('admits an allowed user through the mounted router without touching the network', async () => {
    const { settings, policy } = DiscordGateway.toSettings({
      tokenEnv: 'DSH_DISCORD_BOT_TOKEN',
      allowedUserIds: [USER],
      allowedChannelIds: [],
      workspacePath: process.cwd(),
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
      approvalTimeoutMs: 60_000,
      questionTimeoutMs: 60_000,
      answerers: ['reaction', 'text'],
      enabled: true,
    }, () => '')
    expect(settings.agentPreset).toBe('beardy')
    expect(policy.allowedUserIds.has(USER)).toBe(true)
    expect(DiscordGateway.isAdmitted({
      id: 'm1', channelId: CHANNEL, guildId: '', authorId: USER, bot: false, channelType: 1,
      content: 'hi', mentionedUserIds: [], replyToAuthorId: '',
    }, policy)).toBe(true)
  })
})
