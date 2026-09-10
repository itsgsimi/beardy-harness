import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import type { DiscordPostReply, discordRequest } from '@deepseek-ai/dsh-tool-discord'
import {
  buildDiscordCommandCatalog,
  createDiscordInteractionTransport,
  parseDiscordInteraction,
  synchronizeDiscordCommands,
} from '../src/interactions.ts'
import type { DiscordCommandSyncOptions, DiscordInteraction } from '../src/interactions.ts'

const ID = '1472404859679670455'
const APP = '138391763999129600'
const USER = '138391763999129601'
const CHANNEL = '138391763999129602'
const GUILD = '138391763999129603'
const TOKEN = 'interaction-token'

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID, application_id: APP, token: TOKEN, channel_id: CHANNEL, user: { id: USER }, type: 2,
    data: { type: 1, name: 'status' }, ...overrides,
  }
}

function interaction(): DiscordInteraction {
  const parsed = parseDiscordInteraction(payload())
  if (parsed === undefined) throw new Error('fixture interaction did not parse')
  return parsed
}

function reply(value: unknown = {}, status = 200): DiscordPostReply {
  return { status, retryAfterMs: undefined, body: JSON.stringify(value) }
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('parseDiscordInteraction', () => {
  it('reads bot-DM identity and preserves unstructured arguments', () => {
    expect(parseDiscordInteraction(payload({ data: {
      type: 1, name: 'plan', options: [{ type: 3, name: 'arguments', value: ' first\nsecond ' }],
    } }))).toEqual({
      id: ID, applicationId: APP, token: TOKEN, userId: USER, channelId: CHANNEL, guildId: '',
      kind: 'command', name: 'plan', arguments: ' first\nsecond ',
    })
  })

  it('reads the guild member and a partial channel identity', () => {
    expect(parseDiscordInteraction(payload({ guild_id: GUILD, user: undefined, member: { user: { id: USER } },
      channel_id: undefined, channel: { id: CHANNEL } }))).toMatchObject({ userId: USER, channelId: CHANNEL, guildId: GUILD })
  })

  it('reads a focused arguments completion and component selection', () => {
    expect(parseDiscordInteraction(payload({ type: 4, data: {
      type: 1, name: 'plan', options: [{ type: 3, name: 'arguments', value: 'fi', focused: true }],
    } }))).toMatchObject({ kind: 'autocomplete', name: 'plan', focused: 'fi' })
    expect(parseDiscordInteraction(payload({ type: 3, message: { id: ID }, data: {
      component_type: 3, custom_id: 'approval:request:allow', values: ['one', 'two'],
    } }))).toMatchObject({ kind: 'component', messageId: ID, customId: 'approval:request:allow', values: ['one', 'two'] })
    expect(parseDiscordInteraction(payload({ type: 3, message: { id: ID }, data: { component_type: 2, custom_id: 'allow' } })))
      .toMatchObject({ kind: 'component', values: [] })
  })

  it.each([
    null,
    [],
    payload({ id: 'not-a-snowflake' }),
    payload({ application_id: '../app' }),
    payload({ channel_id: '' }),
    payload({ user: { id: 'user' } }),
    payload({ guild_id: 'guild' }),
    payload({ guild_id: GUILD }),
    payload({ token: '' }),
    payload({ data: null }),
    payload({ type: 5 }),
    payload({ context: 2 }),
    payload({ data: { type: 2, name: 'status' } }),
    payload({ data: { type: 1, name: 'Upper' } }),
    payload({ data: { type: 1, name: 'status', options: {} } }),
    payload({ data: { type: 1, name: 'status', options: [null] } }),
    payload({ data: { type: 1, name: 'status', options: [{ type: 3, name: 'wrong', value: 'text' }] } }),
    payload({ data: { type: 1, name: 'status', options: [{ type: 3, name: 'arguments', value: 3 }] } }),
    payload({ type: 4, data: { type: 1, name: 'plan', options: [] } }),
    payload({ type: 4, data: { type: 1, name: 'plan', options: [{ type: 3, name: 'arguments', value: 'x' }] } }),
    payload({ type: 3, message: { id: 'bad' }, data: { custom_id: 'allow' } }),
    payload({ type: 3, message: { id: ID }, data: { custom_id: '', values: [] } }),
    payload({ type: 3, message: { id: ID }, data: { custom_id: 'allow', values: [4] } }),
  ])('refuses malformed or unsupported wire data %#', (value) => {
    expect(parseDiscordInteraction(value)).toBeUndefined()
  })
})

describe('interaction response transport', () => {
  it('acknowledges, edits, and follows up without bot authorization or mention pings', async () => {
    const request = vi.fn<typeof discordRequest>(async () => reply())
    const transport = createDiscordInteractionTransport({ requestTimeoutMs: 15_000, request })
    const subject = interaction()
    const signal = new AbortController().signal
    await transport.reply(subject, 5, { flags: 64 }, signal)
    await transport.edit(subject, { content: 'answer' }, signal)
    await transport.followup(subject, { content: 'more' }, signal)
    expect(request.mock.calls.map(([request]) => request)).toEqual([
      { method: 'POST', path: `/interactions/${ID}/${TOKEN}/callback`, body: { type: 5, data: { flags: 64 } } },
      { method: 'PATCH', path: `/webhooks/${APP}/${TOKEN}/messages/@original`, body: { content: 'answer', allowed_mentions: { parse: [] } } },
      { method: 'POST', path: `/webhooks/${APP}/${TOKEN}`, body: { content: 'more', flags: 64, allowed_mentions: { parse: [] } } },
    ])
  })

  it('sends autocomplete choices and an empty component acknowledgement', async () => {
    const request = vi.fn<typeof discordRequest>(async () => reply())
    const transport = createDiscordInteractionTransport({ requestTimeoutMs: 15_000, request })
    const signal = new AbortController().signal
    await transport.reply(interaction(), 8, { choices: [{ name: 'first', value: 'first' }] }, signal)
    await transport.reply(interaction(), 6, undefined, signal)
    await transport.reply(interaction(), 7, { content: 'updated' }, signal)
    expect(request.mock.calls.map(([request]) => request.body)).toEqual([
      { type: 8, data: { choices: [{ name: 'first', value: 'first' }] } }, { type: 6 },
      { type: 7, data: { content: 'updated', allowed_mentions: { parse: [] } } },
    ])
  })

  it('cancels a blocked acknowledgement at the protocol deadline', async () => {
    vi.useFakeTimers()
    const request = vi.fn<typeof discordRequest>(async (_request, signal) =>
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('blocked')) }, { once: true })
      }))
    const transport = createDiscordInteractionTransport({ requestTimeoutMs: 15_000, request })
    const acknowledged = transport.reply(interaction(), 5, undefined, new AbortController().signal)
    const rejected = expect(acknowledged).rejects.toThrow('interaction acknowledgement request failed')
    await vi.advanceTimersByTimeAsync(3_000)
    await rejected
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('encodes bearer-token path segments and excludes token-bearing errors', async () => {
    const subject = { ...interaction(), token: 'private/token?secret' }
    const request = vi.fn<typeof discordRequest>(async (request) => { throw new Error(request.path) })
    const transport = createDiscordInteractionTransport({ requestTimeoutMs: 15_000, request })
    await expect(transport.reply(subject, 4, { content: 'hello' }, new AbortController().signal))
      .rejects.toThrow('discord: interaction acknowledgement request failed')
    expect(request.mock.calls[0]?.[0].path).toContain('private%2Ftoken%3Fsecret')
    request.mockResolvedValueOnce(reply({ message: subject.token }, 401))
    await expect(transport.edit(subject, { content: 'answer' }, new AbortController().signal))
      .rejects.toThrow('discord: interaction response edit failed (HTTP 401)')
  })

  it('reports cancellation without exposing its private reason', async () => {
    const controller = new AbortController()
    const request = vi.fn<typeof discordRequest>(async () => { controller.abort(TOKEN); throw new Error(TOKEN) })
    const transport = createDiscordInteractionTransport({ requestTimeoutMs: 1000, request })
    await expect(transport.edit(interaction(), { content: 'text' }, controller.signal))
      .rejects.toThrow('discord: interaction response edit cancelled')
  })
})

const COMMANDS: readonly CommandDescriptor[] = [
  { name: 'status', description: 'Show status' },
  { name: 'plan', description: 'Plan a task', input: { hint: 'What to plan' } },
]

function syncOptions(request: typeof discordRequest): DiscordCommandSyncOptions {
  return { requestTimeoutMs: 15_000, maxRetries: 2, maxRetryWaitMs: 30_000, request }
}

describe('native command catalog', () => {
  it('maps optional command input and bounds discovery descriptions', () => {
    const catalog = buildDiscordCommandCatalog(COMMANDS)
    expect(catalog.map(command => command.name)).toEqual(['plan', 'status'])
    expect(catalog[0]?.options).toEqual([{ type: 3, name: 'arguments', description: 'What to plan', required: false,
      name_localizations: null, description_localizations: null }])
    expect(catalog[1]?.options).toEqual([])
    expect(buildDiscordCommandCatalog([{ name: 'long', description: 'x'.repeat(110), input: { hint: 'y'.repeat(110) } }])[0])
      .toMatchObject({ description: 'x'.repeat(100), options: [{ description: 'y'.repeat(100) }] })
    expect(() => buildDiscordCommandCatalog([{ name: 'x'.repeat(33), description: 'long' }])).toThrow('1 to 32')
    expect(() => buildDiscordCommandCatalog([...COMMANDS, COMMANDS[0]!])).toThrow('duplicate command')
    const oversized = Array.from({ length: 101 }, (_, index) => ({ name: `command${String(index)}`, description: 'Command' }))
    expect(() => buildDiscordCommandCatalog(oversized))
      .toThrow('more than 100')
    expect(() => buildDiscordCommandCatalog([{ name: 'empty', description: '' }])).toThrow('descriptions must not be empty')
    expect(() => buildDiscordCommandCatalog([{ name: 'empty', description: 'Empty argument', input: { hint: '' } }]))
      .toThrow('descriptions must not be empty')
    expect(buildDiscordCommandCatalog([{ name: 'unicode', description: 'x'.repeat(99) + '🌈' }])[0]?.description)
      .toBe('x'.repeat(99))
    expect(buildDiscordCommandCatalog([...COMMANDS].reverse()).map(command => command.name)).toEqual(['plan', 'status'])
  })

  it('leaves a matching catalog unchanged despite remote identities and order', async () => {
    const remote = buildDiscordCommandCatalog(COMMANDS).toReversed()
      .map(command => ({ ...command, id: ID, application_id: APP, version: ID }))
    const request = vi.fn<typeof discordRequest>().mockResolvedValueOnce(reply({ id: APP, interactions_endpoint_url: null }))
      .mockResolvedValueOnce(reply(remote))
    await synchronizeDiscordCommands(APP, 'bot-token', COMMANDS, new AbortController().signal, syncOptions(request))
    expect(request.mock.calls.map(([request]) => request.method)).toEqual(['GET', 'GET'])
  })

  it('replaces stale runtime commands using the bot credential', async () => {
    const request = vi.fn<typeof discordRequest>().mockResolvedValueOnce(reply({ id: APP }))
      .mockResolvedValueOnce(reply([{ type: 1, name: 'hermes', description: 'Old runtime' }])).mockResolvedValueOnce(reply([]))
    await synchronizeDiscordCommands(APP, 'bot-token', COMMANDS, new AbortController().signal, syncOptions(request))
    expect(request.mock.calls[2]?.[0]).toEqual({ method: 'PUT', path: `/applications/${APP}/commands`, token: 'bot-token',
      body: buildDiscordCommandCatalog(COMMANDS) })
  })

  it('rejects another application or configured webhook delivery before publishing commands', async () => {
    for (const [application, error] of [
      [{ id: USER }, 'does not match'],
      [{ id: APP, interactions_endpoint_url: 'https://old-runtime.example/interactions' }, 'clear the Interactions Endpoint URL'],
    ] as const) {
      const request = vi.fn<typeof discordRequest>().mockResolvedValue(reply(application))
      await expect(synchronizeDiscordCommands(APP, 'bot-token', COMMANDS, new AbortController().signal, syncOptions(request))).rejects.toThrow(error)
      expect(request).toHaveBeenCalledTimes(1)
    }
  })

  it('retries rate limits within the configured count and wait budget', async () => {
    const request = vi.fn<typeof discordRequest>().mockResolvedValueOnce(reply({ retry_after: 0.25 }, 429))
      .mockResolvedValueOnce(reply({ id: APP })).mockResolvedValueOnce(reply(buildDiscordCommandCatalog(COMMANDS)))
    const wait = vi.fn(async () => {})
    await synchronizeDiscordCommands(APP, 'bot-token', COMMANDS, new AbortController().signal, { ...syncOptions(request), wait })
    expect(wait).toHaveBeenCalledWith(250, expect.any(AbortSignal))
    expect(request).toHaveBeenCalledTimes(3)
    request.mockReset().mockResolvedValue(reply({ retry_after: 60 }, 429))
    await expect(synchronizeDiscordCommands(APP, 'bot-token', COMMANDS, new AbortController().signal, syncOptions(request)))
      .rejects.toThrow('rate limit exceeds')
    request.mockReset().mockResolvedValue(reply({ message: 'Denied' }, 403))
    await expect(synchronizeDiscordCommands(APP, 'bot-token', COMMANDS, new AbortController().signal, syncOptions(request)))
      .rejects.toThrow('HTTP 403: Denied')
  })

  it.each(['not-json', '{}'])('refuses an invalid catalog before overwriting it: %s', async (body) => {
    const request = vi.fn<typeof discordRequest>().mockResolvedValueOnce(reply({ id: APP }))
      .mockResolvedValueOnce({ status: 200, retryAfterMs: undefined, body })
    await expect(synchronizeDiscordCommands(APP, 'bot-token', COMMANDS, new AbortController().signal, syncOptions(request)))
      .rejects.toThrow('command catalog response')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it.each([
    null,
    { type: 2 },
    { name: 'other' },
    { description: 'Old description' },
    { contexts: [0] },
    { contexts: [1, 2] },
    { contexts: [0, 2] },
    { contexts: undefined },
    { default_member_permissions: '8' },
    { nsfw: true },
    { name_localizations: { de: 'planen' } },
    { description_localizations: { de: 'Aufgabe planen' } },
    { options: {} },
    { options: undefined },
    { options: [null] },
    { option: { choices: [{ name: 'old', value: 'old' }] } },
    { option: { choices: 'old' } },
    { option: { required: true } },
    { option: { min_length: 5 } },
    { option: { max_length: 5 } },
    { option: { name_localizations: { de: 'texte' } } },
    { option: { description_localizations: { de: 'Plan' } } },
    { option: { autocomplete: true } },
  ])('reconciles stale fields in an otherwise matching catalog %#', async (changes) => {
    const catalog = buildDiscordCommandCatalog(COMMANDS)
    const first = catalog[0]!
    const entry = changes === null ? null : 'option' in changes
      ? { ...first, options: [{ ...first.options[0], ...changes.option }] } : { ...first, ...changes }
    const request = vi.fn<typeof discordRequest>().mockResolvedValueOnce(reply({ id: APP }))
      .mockResolvedValueOnce(reply([entry, catalog[1]])).mockResolvedValueOnce(reply([]))
    await synchronizeDiscordCommands(APP, 'bot-token', COMMANDS, new AbortController().signal, syncOptions(request))
    expect(request.mock.calls[2]?.[0].method).toBe('PUT')
  })

  it('accepts empty remote choices and omitted options on an input-free command', async () => {
    const catalog = buildDiscordCommandCatalog(COMMANDS)
    const request = vi.fn<typeof discordRequest>().mockResolvedValueOnce(reply({ id: APP }))
      .mockResolvedValueOnce(reply([{ ...catalog[0], options: [{ ...catalog[0]!.options[0], choices: [] }] },
        { ...catalog[1], options: undefined }]))
    await synchronizeDiscordCommands(APP, 'bot-token', COMMANDS, new AbortController().signal, syncOptions(request))
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('bounds retries with missing JSON delays and cancels a rate-limit wait', async () => {
    vi.useFakeTimers()
    const request = vi.fn<typeof discordRequest>().mockResolvedValueOnce({ status: 429, body: '{}', retryAfterMs: 20 })
      .mockResolvedValueOnce(reply({ id: APP })).mockResolvedValueOnce(reply(buildDiscordCommandCatalog(COMMANDS)))
    const completed = synchronizeDiscordCommands(APP, 'bot-token', COMMANDS, new AbortController().signal, syncOptions(request))
    await vi.advanceTimersByTimeAsync(20)
    await completed
    request.mockReset().mockResolvedValue(reply({ retry_after: 0 }, 429))
    const limited = synchronizeDiscordCommands(APP, 'bot-token', COMMANDS, new AbortController().signal,
      { ...syncOptions(request), maxRetries: 0 })
    await expect(limited).rejects.toThrow('HTTP 429)')
    expect(request).toHaveBeenCalledTimes(1)
    request.mockReset().mockResolvedValue(reply({}, 429))
    await expect(synchronizeDiscordCommands(APP, 'bot-token', COMMANDS, new AbortController().signal, syncOptions(request)))
      .rejects.toThrow('configured wait')
    request.mockReset().mockResolvedValue(reply({ retry_after: 20 }, 429))
    const controller = new AbortController()
    const cancelled = synchronizeDiscordCommands(APP, 'bot-token', COMMANDS, controller.signal, syncOptions(request))
    const rejected = expect(cancelled).rejects.toThrow('synchronization cancelled')
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops before sending a pre-cancelled request', async () => {
    const controller = new AbortController()
    controller.abort(new Error('listener stopped'))
    const request = vi.fn<typeof discordRequest>()
    await expect(synchronizeDiscordCommands(APP, 'bot-token', COMMANDS, controller.signal, syncOptions(request)))
      .rejects.toThrow('listener stopped')
    expect(request).not.toHaveBeenCalled()
  })

  it('uses the production REST implementation and default reconciliation bounds', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url === 'https://discord.com/api/v10/applications/@me') return Response.json({ id: APP })
      expect(url).toBe(`https://discord.com/api/v10/applications/${APP}/commands`)
      return Response.json(buildDiscordCommandCatalog(COMMANDS))
    })
    await synchronizeDiscordCommands(APP, 'bot-token', COMMANDS, new AbortController().signal)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
