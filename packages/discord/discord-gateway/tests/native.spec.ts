import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { DiscordInteractionId } from '../src/interactions.ts'
import type { DiscordInteraction, DiscordInteractionTransport } from '../src/interactions.ts'
import { createNativeInteractions } from '../src/native.ts'
import type { NativeInteractionDeps, NativeInteractions } from '../src/native.ts'
import { CONVERSATION_CONTROLS } from '../src/presentation.ts'
import { CHANNEL, GUILD_CHANNEL, SETTINGS, USER } from './support.ts'

const APP = '138391763999129609'
const ID = DiscordInteractionId('1472404859679670455')
const GUILD = '138391763999129610'
const TOKEN = 'private-response-token'
const owners: NativeInteractions[] = []
const releaseBarriers: (() => void)[] = []

function barrier<T>(cancelled: T) {
  const deferred = Promise.withResolvers<T>()
  releaseBarriers.push(() => { deferred.resolve(cancelled) })
  return deferred
}

function interaction(id = ID): DiscordInteraction {
  return { id, applicationId: APP, token: TOKEN, userId: USER, channelId: CHANNEL, guildId: '',
    kind: 'command', name: 'status', arguments: '' }
}

function component(customId: string): Extract<DiscordInteraction, { kind: 'component' }> {
  return { id: ID, applicationId: APP, token: TOKEN, userId: USER, channelId: CHANNEL, guildId: '',
    kind: 'component', messageId: '1472404859679670456', customId, values: ['1'] }
}

function harness(overrides: Partial<NativeInteractionDeps> = {}, productionTransport = false) {
  const abort = new AbortController()
  const reply = vi.fn<DiscordInteractionTransport['reply']>(async () => {})
  const edit = vi.fn<DiscordInteractionTransport['edit']>(async () => {})
  const followup = vi.fn<DiscordInteractionTransport['followup']>(async () => {})
  const execute = vi.fn<NativeInteractionDeps['execute']>(async () => ({ kind: 'success', text: 'Current status' }))
  const resolveComponent = vi.fn<NativeInteractionDeps['component']>(async () => 'Answer accepted.')
  const warn = vi.fn<NativeInteractionDeps['warn']>()
  const owner = createNativeInteractions({ signal: abort.signal,
    policy: { allowedUserIds: new Set([USER]), allowedChannelIds: new Set([GUILD_CHANNEL]),
      guildRequireMention: true, botUserId: () => APP },
    settings: SETTINGS, applicationId: () => APP,
    commands: () => [{ name: 'status', description: 'Show status' }, { name: 'plan', description: 'Plan', input: { hint: 'Task' } }],
    execute, component: resolveComponent, ...(productionTransport ? {} : { transport: { reply, edit, followup } }), warn, ...overrides,
  })
  owners.push(owner)
  return { owner, abort, reply, edit, followup, execute, resolveComponent, warn }
}

afterEach(async () => {
  const disposed = owners.splice(0).map(owner => owner.dispose())
  for (const release of releaseBarriers.splice(0)) release()
  await Promise.all(disposed)
  vi.restoreAllMocks()
})

describe('native interaction execution', () => {
  it('acknowledges privately before executing the exact command input', async () => {
    const acknowledged = barrier<undefined>(undefined)
    const h = harness()
    h.reply.mockImplementation(async () => { await acknowledged.promise })
    const subject = { ...interaction(), kind: 'command' as const, name: 'plan', arguments: ' first\nsecond ' }
    h.owner.handle(subject)
    expect(h.reply).toHaveBeenCalledWith(subject, 5, { flags: 64 }, expect.any(AbortSignal))
    expect(h.execute).not.toHaveBeenCalled()
    acknowledged.resolve(undefined)
    await vi.waitFor(() => { expect(h.edit).toHaveBeenCalledWith(subject, { content: 'Current status' }, expect.any(AbortSignal)) })
    expect(h.execute).toHaveBeenCalledWith(CHANNEL, '/plan  first\nsecond ', expect.any(AbortSignal))
  })

  it('admits an explicit command in an allowlisted guild channel without a mention', async () => {
    const h = harness()
    h.owner.handle({ ...interaction(), guildId: GUILD, channelId: GUILD_CHANNEL })
    await vi.waitFor(() => { expect(h.edit).toHaveBeenCalledTimes(1) })
    expect(h.execute).toHaveBeenCalledWith(GUILD_CHANNEL, '/status', expect.any(AbortSignal))
  })

  it.each([{ userId: '138391763999129699' }, { guildId: GUILD, channelId: CHANNEL }])('rejects an unauthorized invocation %j', async (overrides) => {
    const h = harness()
    const subject = { ...interaction(), ...overrides }
    h.owner.handle(subject)
    expect(h.reply).toHaveBeenCalledWith(subject, 4,
      { content: 'You do not have access to this bot in this channel.', flags: 64 }, expect.any(AbortSignal))
    await h.owner.dispose()
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.resolveComponent).not.toHaveBeenCalled()
  })

  it('ignores another application and a stopped listener before creating a response', async () => {
    const h = harness()
    h.owner.handle({ ...interaction(), applicationId: USER })
    h.abort.abort()
    h.owner.handle(interaction())
    await h.owner.dispose()
    expect(h.reply).not.toHaveBeenCalled()
  })

  it('acknowledges autocomplete without starting an agent or exposing unauthorized choices', async () => {
    const h = harness()
    const subject: DiscordInteraction = { ...interaction(), kind: 'autocomplete', name: 'plan', focused: 'fi', userId: '138391763999129699' }
    h.owner.handle(subject)
    expect(h.reply).toHaveBeenCalledWith(subject, 8, { choices: [] }, expect.any(AbortSignal))
    await h.owner.dispose()
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('routes command buttons through the same executor and prompt controls through their resolver', async () => {
    const h = harness()
    h.owner.handle(component('dsh:command:status'))
    await vi.waitFor(() => { expect(h.edit).toHaveBeenCalledTimes(1) })
    expect(h.execute).toHaveBeenCalledWith(CHANNEL, '/status', expect.any(AbortSignal))
    const prompt = { ...component('dsh:question:pending-id'), id: DiscordInteractionId('1472404859679670457') }
    h.owner.handle(prompt)
    await vi.waitFor(() => { expect(h.edit).toHaveBeenCalledTimes(2) })
    expect(h.resolveComponent).toHaveBeenCalledWith(prompt, expect.any(AbortSignal))
    expect(h.reply.mock.calls.map(([, type]) => type)).toEqual([5, 5])
  })

  it('refuses stale menu commands and malformed command control names', async () => {
    const h = harness()
    h.owner.handle({ ...interaction(), kind: 'command', name: 'hermes', arguments: '' })
    await vi.waitFor(() => { expect(h.edit).toHaveBeenCalledTimes(1) })
    h.owner.handle({ ...component('dsh:command:status dangerous'), id: DiscordInteractionId('1472404859679670457') })
    await vi.waitFor(() => { expect(h.edit).toHaveBeenCalledTimes(2) })
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.resolveComponent).not.toHaveBeenCalled()
    expect(h.edit.mock.calls[0]?.[1].content).toContain('no longer available')
  })

  it('renders cards with current-conversation controls and private followup chunks', async () => {
    const h = harness({ settings: { ...SETTINGS, richMessages: true, accentColor: 42 } })
    h.execute.mockResolvedValue({ kind: 'error', text: '@everyone ' + 'word '.repeat(460) })
    h.owner.handle(interaction())
    await vi.waitFor(() => { expect(h.followup).toHaveBeenCalledTimes(1) })
    expect(h.edit.mock.calls[0]?.[1]).toMatchObject({ content: '', embeds: [{ title: '/status failed', color: 42 }] })
    expect(h.edit.mock.calls[0]?.[1].embeds?.[0]?.description).toContain('@\u200beveryone')
    expect(h.followup.mock.calls[0]?.[1].components).toEqual(CONVERSATION_CONTROLS)
  })

  it('bounds reply chunks and acknowledges command success without text', async () => {
    const h = harness({ settings: { ...SETTINGS, replyMaxChunksPerCall: 1 } })
    h.execute.mockResolvedValueOnce({ kind: 'success', text: 'x'.repeat(2100) }).mockResolvedValueOnce({ kind: 'success' })
    h.owner.handle(interaction())
    await vi.waitFor(() => { expect(h.edit).toHaveBeenCalledTimes(1) })
    expect(h.edit.mock.calls[0]?.[1].content).toContain('too long')
    h.owner.handle(interaction(DiscordInteractionId('1472404859679670457')))
    await vi.waitFor(() => { expect(h.edit).toHaveBeenCalledTimes(2) })
    expect(h.edit.mock.calls[1]?.[1]).toEqual({ content: 'Done.' })
    expect(h.followup).not.toHaveBeenCalled()
  })

  it('suppresses in-flight duplicates and evicts completed identities at the configured limit', async () => {
    const running = barrier<CommandResult>({ kind: 'success' })
    const h = harness({ settings: { ...SETTINGS, interactionReceiptLimit: 1 } })
    h.execute.mockImplementationOnce(async () => await running.promise)
    h.owner.handle(interaction())
    h.owner.handle(interaction())
    await vi.waitFor(() => { expect(h.execute).toHaveBeenCalledTimes(1) })
    running.resolve({ kind: 'success', text: 'Finished' })
    await vi.waitFor(() => { expect(h.edit).toHaveBeenCalledTimes(1) })
    h.owner.handle(interaction())
    expect(h.reply).toHaveBeenCalledTimes(1)
    h.owner.handle(interaction(DiscordInteractionId('1472404859679670457')))
    await vi.waitFor(() => { expect(h.edit).toHaveBeenCalledTimes(2) })
    h.owner.handle(interaction())
    await vi.waitFor(() => { expect(h.edit).toHaveBeenCalledTimes(3) })
  })

  it('keeps one bounded busy acknowledgement while all execution slots are occupied', async () => {
    const running = barrier<CommandResult>({ kind: 'success' })
    const busy = barrier<undefined>(undefined)
    const h = harness({ settings: { ...SETTINGS, interactionMaxPending: 1 } })
    h.execute.mockImplementation(async () => await running.promise)
    h.reply.mockImplementation(async (_interaction, type) => { if (type === 4) await busy.promise })
    h.owner.handle(interaction())
    await vi.waitFor(() => { expect(h.execute).toHaveBeenCalledTimes(1) })
    h.owner.handle(interaction(DiscordInteractionId('1472404859679670457')))
    h.owner.handle(interaction(DiscordInteractionId('1472404859679670458')))
    expect(h.reply).toHaveBeenCalledTimes(2)
    expect(h.reply.mock.calls[1]?.[2]?.flags).toBe(64)
    expect(h.reply.mock.calls[1]?.[2]?.content).toContain('Too many')
    busy.resolve(undefined)
    running.resolve({ kind: 'success' })
    await h.owner.dispose()
  })

  it('sanitizes handler and response errors without executing after a failed acknowledgement', async () => {
    const h = harness()
    h.reply.mockRejectedValueOnce(new Error(TOKEN))
    h.owner.handle(interaction())
    await vi.waitFor(() => { expect(h.warn).toHaveBeenCalledTimes(1) })
    expect(h.execute).not.toHaveBeenCalled()
    h.execute.mockRejectedValueOnce(new Error(TOKEN))
    h.owner.handle(interaction(DiscordInteractionId('1472404859679670457')))
    await vi.waitFor(() => { expect(h.edit).toHaveBeenCalledTimes(1) })
    expect(h.edit.mock.calls[0]?.[1].content).toContain('could not be completed')
    h.edit.mockRejectedValueOnce(new Error(TOKEN))
    h.owner.handle(interaction(DiscordInteractionId('1472404859679670458')))
    await vi.waitFor(() => { expect(h.warn).toHaveBeenCalledTimes(3) })
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain(TOKEN)
  })

  it('cancels and joins an active command on disposal without posting a late response', async () => {
    const entered = Promise.withResolvers<undefined>()
    const left = Promise.withResolvers<undefined>()
    const h = harness()
    h.execute.mockImplementation(async (_channel, _line, signal) => {
      entered.resolve(undefined)
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => { left.resolve(undefined); reject(new Error(TOKEN)) }, { once: true })
      })
      return { kind: 'success' }
    })
    h.owner.handle(interaction())
    await entered.promise
    await h.owner.dispose()
    await left.promise
    h.owner.handle(interaction(DiscordInteractionId('1472404859679670457')))
    expect(h.edit).not.toHaveBeenCalled()
    expect(h.warn).not.toHaveBeenCalled()
    expect(h.reply).toHaveBeenCalledTimes(1)
  })

  it('renders an expired or blank prompt result without claiming an answer was recorded', async () => {
    const h = harness({ settings: { ...SETTINGS, richMessages: true } })
    h.resolveComponent.mockResolvedValueOnce('This request has expired.').mockResolvedValueOnce(' ')
    h.owner.handle(component('dsh:question:old'))
    await vi.waitFor(() => { expect(h.edit).toHaveBeenCalledTimes(1) })
    expect(h.edit.mock.calls[0]?.[1]).toEqual({ content: '', embeds: [{ title: 'Request', color: SETTINGS.accentColor,
      description: 'This request has expired.' }] })
    h.owner.handle({ ...component('dsh:question:new'), id: DiscordInteractionId('1472404859679670457') })
    await vi.waitFor(() => { expect(h.edit).toHaveBeenCalledTimes(2) })
    expect(h.edit.mock.calls[1]?.[1].embeds?.[0]?.description).toBe('Done.')
  })

  it('contains failed overload callbacks and uses an empty autocomplete callback while busy', async () => {
    const running = barrier<CommandResult>({ kind: 'success' })
    const h = harness({ settings: { ...SETTINGS, interactionMaxPending: 1 } })
    h.execute.mockImplementation(async () => await running.promise)
    h.owner.handle(interaction())
    await vi.waitFor(() => { expect(h.execute).toHaveBeenCalledTimes(1) })
    h.reply.mockRejectedValueOnce(new Error(TOKEN))
    h.owner.handle({ ...interaction(DiscordInteractionId('1472404859679670457')), kind: 'autocomplete', name: 'status', focused: '' })
    await vi.waitFor(() => { expect(h.warn).toHaveBeenCalledWith('discord-gateway: native overload acknowledgement failed') })
    expect(h.reply.mock.calls[1]?.[1]).toBe(8)
    h.reply.mockImplementationOnce(async () => { h.abort.abort(); throw new Error(TOKEN) })
    h.owner.handle(interaction(DiscordInteractionId('1472404859679670458')))
    running.resolve({ kind: 'success' })
    await h.owner.dispose()
    expect(h.warn).toHaveBeenCalledTimes(1)
  })

  it('does not retry response delivery after listener cancellation', async () => {
    const h = harness()
    h.edit.mockImplementation(async () => { h.abort.abort(); throw new Error(TOKEN) })
    h.owner.handle(interaction())
    await vi.waitFor(() => { expect(h.edit).toHaveBeenCalledTimes(1) })
    await h.owner.dispose()
    expect(h.warn).not.toHaveBeenCalled()
  })

  it('cancels an outstanding acknowledgement before any command starts', async () => {
    const h = harness()
    h.reply.mockImplementation(async (_interaction, _type, _data, signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error(TOKEN)) }, { once: true })
      })
    })
    h.owner.handle(interaction())
    expect(h.reply).toHaveBeenCalledTimes(1)
    await h.owner.dispose()
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.warn).not.toHaveBeenCalled()
  })

  it('uses the configured production transport when no transport override is supplied', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      expect(url).toMatch(/^https:\/\/discord\.com\/api\/v10\/(?:interactions|webhooks)\//)
      return Response.json({})
    })
    const h = harness({}, true)
    h.owner.handle(interaction())
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(2) })
    expect(h.execute).toHaveBeenCalledTimes(1)
  })
})
