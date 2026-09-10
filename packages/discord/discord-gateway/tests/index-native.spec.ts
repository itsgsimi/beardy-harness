/** Listener-owned command synchronization and native interaction lifecycle. */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { discordCommands } from '../src/commands.ts'
import type { ConversationRouter } from '../src/conversation.ts'
import type { DiscordGatewayOptions } from '../src/gateway.ts'
import { startListener } from '../src/index.ts'
import type { GatewayConnector, ResolvedConfig } from '../src/index.ts'
import { buildDiscordCommandCatalog, DiscordInteractionId } from '../src/interactions.ts'
import type { DiscordInteraction } from '../src/interactions.ts'
import { BOT_USER, CHANNEL, inbound, SETTINGS, USER } from './support.ts'

const APP = '1472404859679670456'
const ID = DiscordInteractionId('1472404859679670458')
const CATALOG_PATH = `/api/v10/applications/${APP}/commands`
const releases: (() => void)[] = []
const owners: { abort: AbortController; done: Promise<void> }[] = []

function barrier() {
  const deferred = Promise.withResolvers<undefined>()
  const resolve = (): void => { deferred.resolve(undefined) }
  releases.push(resolve)
  return { promise: deferred.promise, resolve }
}

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    ...SETTINGS,
    excludedPresetCommands: [...SETTINGS.excludedPresetCommands],
    answerers: [...SETTINGS.answerers],
    tokenEnv: 'DISCORD_SNAPSHOT_TOKEN',
    allowedUserIds: [USER],
    allowedChannelIds: [],
    nativeCommands: true,
    commandSyncRetryMs: 100,
    reconnectDelayMs: 1_000,
    maxReconnectDelayMs: 30_000,
    replyMaxRetries: 0,
    enabled: true,
    ...overrides,
  }
}

function command(): DiscordInteraction {
  return { id: ID, applicationId: APP, token: 'private-interaction-token', userId: USER,
    channelId: CHANNEL, guildId: '', kind: 'command', name: 'status', arguments: '' }
}

async function listener(overrides: Partial<ResolvedConfig> = {}) {
  const abort = new AbortController()
  const connected = Promise.withResolvers<DiscordGatewayOptions>()
  const observer = new Set<() => void>()
  let descriptors: readonly CommandDescriptor[] = [{ name: 'plan', description: 'Plan the next task' }]
  const listForScope = vi.fn(() => descriptors)
  const scope = {}
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
  const removeObserver = vi.fn()
  const ctx = {
    logger,
    credentials: { resolve: async () => ({ value: 'private-bot-token' }) },
    agentPresets: { resolve: async () => ({}), standingKeyFor: async () => scope },
    permissionPresets: { resolve: () => ({}) },
    commands: { listForScope },
    on: (name: string, callback: () => void) => {
      expect(name).toBe('commands/change')
      observer.add(callback)
      return () => { observer.delete(callback); removeObserver() }
    },
  } as unknown as Context
  const execute = vi.fn<ConversationRouter['execute']>(async () => ({ kind: 'success', text: 'Idle.' }))
  const component = vi.fn<ConversationRouter['component']>(async () => 'Answer accepted.')
  const handle = vi.fn()
  const router = { execute, component, handle, handleReaction: vi.fn() } as unknown as ConversationRouter
  const connect: GatewayConnector = async (options, signal) => {
    connected.resolve(options)
    if (signal.aborted) return
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
  }
  const done = startListener(ctx, config(overrides), router, abort.signal, connect)
  owners.push({ abort, done })
  const options = await connected.promise
  return {
    abort, done, options, execute, component, handle, logger, listForScope, removeObserver,
    ready: () => { options.onReady?.(BOT_USER, APP) },
    catalog: () => buildDiscordCommandCatalog(discordCommands(descriptors, ['export'])),
    change: (next: readonly CommandDescriptor[] = descriptors) => {
      descriptors = next
      for (const callback of observer) callback()
    },
  }
}

interface RequestCall {
  method: string
  path: string
  body: unknown
  signal: AbortSignal
}

function rest(respond: (call: RequestCall) => Response | Promise<Response>) {
  const calls: RequestCall[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    expect(url.origin).toBe('https://discord.com')
    if (init?.signal === undefined || init.signal === null) throw new Error('Discord request is missing cancellation')
    const call = {
      method: init.method ?? 'GET', path: url.pathname, signal: init.signal,
      body: typeof init.body === 'string' ? JSON.parse(init.body) as unknown : undefined,
    }
    calls.push(call)
    return respond(call)
  })
  return calls
}

function application(): Response {
  return Response.json({ id: APP, interactions_endpoint_url: null })
}

afterEach(async () => {
  const stopped = owners.splice(0)
  for (const owner of stopped) owner.abort.abort()
  for (const release of releases.splice(0)) release()
  await Promise.all(stopped.map(owner => owner.done))
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('native command synchronization owned by the gateway listener', () => {
  it('skips an unchanged catalog and publishes a later registration change', async () => {
    const h = await listener()
    const reading = barrier()
    const releaseRead = barrier()
    const firstCatalog = h.catalog()
    let catalogReads = 0
    const writes: unknown[] = []
    rest(async (call) => {
      if (call.path === '/api/v10/applications/@me') return application()
      expect(call.path).toBe(CATALOG_PATH)
      if (call.method === 'PUT') { writes.push(call.body); return Response.json(call.body) }
      if (++catalogReads === 1) { reading.resolve(); await releaseRead.promise }
      return Response.json(firstCatalog)
    })
    h.ready()
    await reading.promise
    const observations = h.listForScope.mock.calls.length
    h.change()
    releaseRead.resolve()
    // The queued change must be observed before an absent catalog write proves the skip.
    await vi.waitFor(() => { expect(h.listForScope.mock.calls.length).toBeGreaterThan(observations) })
    expect(catalogReads).toBe(1)
    expect(writes).toEqual([])
    h.change([{ name: 'plan', description: 'Plan the next task' }, { name: 'goal', description: 'Manage the task goal' }])
    await vi.waitFor(() => { expect(writes).toEqual([h.catalog()]) })
    expect(catalogReads).toBe(2)
    h.abort.abort()
    await h.done
    expect(h.removeObserver).toHaveBeenCalledTimes(1)
    expect(h.logger.error).not.toHaveBeenCalled()
  })

  it('coalesces registrations that change while an earlier catalog write is in flight', async () => {
    const h = await listener()
    const writing = barrier()
    const releaseWrite = barrier()
    const writes: unknown[] = []
    let metadataReads = 0
    let remote: unknown = []
    rest(async (call) => {
      if (call.path === '/api/v10/applications/@me') { metadataReads++; return application() }
      expect(call.path).toBe(CATALOG_PATH)
      if (call.method === 'GET') return Response.json(remote)
      writes.push(call.body)
      if (writes.length === 1) { writing.resolve(); await releaseWrite.promise }
      remote = call.body
      return Response.json(remote)
    })
    const initial = h.catalog()
    h.ready()
    await writing.promise
    h.change([{ name: 'draft', description: 'Draft the task' }])
    h.change([{ name: 'review', description: 'Review the task' }])
    h.change([{ name: 'goal', description: 'Manage the task goal' }])
    expect(metadataReads).toBe(1)
    expect(writes).toEqual([initial])
    releaseWrite.resolve()
    await vi.waitFor(() => { expect(writes).toEqual([initial, h.catalog()]) })
    expect(metadataReads).toBe(2)
  })

  it('keeps delivering inbound messages while a failed menu synchronization waits to retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await listener()
    const failed = barrier()
    const written = barrier()
    h.logger.warn.mockImplementation(() => { failed.resolve() })
    let attempts = 0
    rest((call) => {
      if (call.path === '/api/v10/applications/@me') {
        return ++attempts === 1 ? Response.json({ message: 'temporarily unavailable' }, { status: 503 }) : application()
      }
      expect(call.path).toBe(CATALOG_PATH)
      if (call.method === 'GET') return Response.json([])
      written.resolve()
      return Response.json(call.body)
    })
    h.ready()
    await failed.promise
    const message = inbound()
    h.options.onMessage(message)
    expect(h.handle).toHaveBeenCalledWith(message)
    expect(attempts).toBe(1)
    await vi.advanceTimersByTimeAsync(100)
    await written.promise
    expect(attempts).toBe(2)
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('native command sync failed; retrying'))
    h.abort.abort()
    await h.done
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rechecks Discord after a fresh READY even when the local command roster has not changed', async () => {
    const h = await listener()
    const reading = barrier()
    const releaseRead = barrier()
    let catalogReads = 0
    let metadataReads = 0
    let remote: unknown = h.catalog()
    const writes: unknown[] = []
    rest(async (call) => {
      if (call.path === '/api/v10/applications/@me') { metadataReads++; return application() }
      expect(call.path).toBe(CATALOG_PATH)
      if (call.method === 'PUT') { writes.push(call.body); return Response.json(call.body) }
      if (++catalogReads === 1) { reading.resolve(); await releaseRead.promise }
      return Response.json(remote)
    })
    h.ready()
    await reading.promise
    const observations = h.listForScope.mock.calls.length
    h.change()
    releaseRead.resolve()
    await vi.waitFor(() => { expect(h.listForScope.mock.calls.length).toBeGreaterThan(observations) })
    remote = [{ type: 1, name: 'hermes', description: 'Another runtime' }]
    h.ready()
    await vi.waitFor(() => { expect(writes).toEqual([h.catalog()]) })
    expect(metadataReads).toBe(2)
    expect(catalogReads).toBe(2)
  })

  it('cancels and joins both a catalog request and native command cleanup during disposal', async () => {
    const h = await listener()
    const syncEntered = barrier()
    const syncCancelled = barrier()
    const releaseSync = barrier()
    const commandEntered = barrier()
    const commandCancelled = barrier()
    const releaseCommand = barrier()
    let syncSignal: AbortSignal | undefined
    let commandSignal: AbortSignal | undefined
    const calls = rest(async (call) => {
      if (call.path === '/api/v10/applications/@me') {
        syncSignal = call.signal
        syncEntered.resolve()
        call.signal.addEventListener('abort', () => { syncCancelled.resolve() }, { once: true })
        await releaseSync.promise
        throw new Error('catalog request cancelled')
      }
      expect(call.path).toContain('/callback')
      return new Response(null, { status: 204 })
    })
    h.execute.mockImplementation(async (_channel, _line, signal) => {
      if (signal === undefined) throw new Error('native command has no cancellation signal')
      commandSignal = signal
      commandEntered.resolve()
      signal.addEventListener('abort', () => { commandCancelled.resolve() }, { once: true })
      await releaseCommand.promise
      return { kind: 'success', text: 'Command cleanup finished.' }
    })
    h.ready()
    await syncEntered.promise
    h.options.onInteraction?.(command())
    await commandEntered.promise
    let settled = false
    void h.done.then(() => { settled = true })
    h.abort.abort()
    await Promise.all([syncCancelled.promise, commandCancelled.promise])
    expect(syncSignal?.aborted).toBe(true)
    expect(commandSignal?.aborted).toBe(true)
    expect(settled).toBe(false)
    releaseSync.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    releaseCommand.resolve()
    await h.done
    expect(settled).toBe(true)
    expect(h.removeObserver).toHaveBeenCalledTimes(1)
    expect(calls.map(call => call.method)).toEqual(['GET', 'POST'])
    expect(h.logger.warn).not.toHaveBeenCalled()
  })

  it.each([
    { richMessages: false, answerers: ['component'] },
    { richMessages: true, answerers: ['text'] },
  ])('answers components without owning the native command catalog: %j', async (overrides) => {
    const h = await listener({ ...overrides, nativeCommands: false })
    const delivered = barrier()
    const calls = rest((call) => {
      if (call.path.endsWith('/callback')) return new Response(null, { status: 204 })
      expect(call.path).toContain('/webhooks/')
      delivered.resolve()
      return Response.json({ id: ID })
    })
    h.ready()
    h.options.onInteraction?.({ ...command(), kind: 'component', messageId: ID,
      customId: 'dsh:question:pending', values: ['1'] })
    await delivered.promise
    expect(h.component).toHaveBeenCalledWith(expect.objectContaining({ customId: 'dsh:question:pending' }), expect.any(AbortSignal))
    expect(calls.map(call => call.method)).toEqual(['POST', 'PATCH'])
    expect(h.execute).not.toHaveBeenCalled()
    h.abort.abort()
    await h.done
    expect(h.removeObserver).not.toHaveBeenCalled()
  })
})
