import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiscordPostReply } from '../src/http.ts'
import { DISCORD_API_BASE, DISCORD_MAX_RESPONSE_BYTES, discordReplyMessage, openDirectMessageChannel, postChannelMessage, postTyping } from '../src/http.ts'

const CHANNEL = '1478276183543119914'

interface CapturedRequest {
  url: string
  method?: string | undefined
  redirect?: RequestRedirect | undefined
  headers: Record<string, string>
  body?: string | undefined
}

/** Stub the global fetch with a fixed reply and capture the request it was called with. */
function stubFetch(response: Response): CapturedRequest[] {
  const calls: CapturedRequest[] = []
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      redirect: init?.redirect,
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: typeof init?.body === 'string' ? init.body : undefined,
    })
    return Promise.resolve(response)
  })
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Encode text as one chunk of a stream the reader must reassemble. */
function streamed(texts: readonly string[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const text of texts) controller.enqueue(encoder.encode(text))
      controller.close()
    },
  }))
}

describe('postChannelMessage', () => {
  it('posts to the channel endpoint with mentions disabled and redirects refused', async () => {
    const calls = stubFetch(streamed(['{"id":"42"}']))
    const reply = await postChannelMessage({ channelId: CHANNEL, token: 'secret-token', content: 'hello' }, new AbortController().signal)

    expect(calls).toHaveLength(1)
    const call = calls[0] as CapturedRequest
    expect(call.url).toBe(`${DISCORD_API_BASE}/channels/${CHANNEL}/messages`)
    expect(call.method).toBe('POST')
    expect(call.redirect).toBe('error')
    expect(call.headers.authorization).toBe('Bot secret-token')
    expect(call.headers['content-type']).toBe('application/json')
    expect(JSON.parse(call.body as string)).toEqual({ content: 'hello', allowed_mentions: { parse: [] } })
    expect(reply.status).toBe(200)
    expect(reply.body).toBe('{"id":"42"}')
  })

  it('reassembles a body delivered in several chunks and decodes UTF-8', async () => {
    stubFetch(streamed(['weather: ☀️ ', 'sunny']))
    const reply = await postChannelMessage({ channelId: CHANNEL, token: 't', content: 'x' }, new AbortController().signal)
    expect(reply.body).toBe('weather: ☀️ sunny')
  })

  it('returns an empty body when the response carries none', async () => {
    stubFetch(new Response(null, { status: 204 }))
    const reply = await postChannelMessage({ channelId: CHANNEL, token: 't', content: 'x' }, new AbortController().signal)
    expect(reply.status).toBe(204)
    expect(reply.body).toBe('')
  })

  it.each([
    ['1.5', 1_500],
    ['0', 0],
    ['3', 3_000],
  ])('reads a Retry-After header of %s seconds', async (header, expected) => {
    stubFetch(new Response('{}', { status: 429, headers: { 'retry-after': header } }))
    const reply = await postChannelMessage({ channelId: CHANNEL, token: 't', content: 'x' }, new AbortController().signal)
    expect(reply.retryAfterMs).toBe(expected)
  })

  it.each([undefined, 'soon', '-2'])('ignores an unusable Retry-After header %p', async (header) => {
    stubFetch(new Response('{}', { status: 429, headers: header === undefined ? {} : { 'retry-after': header } }))
    const reply = await postChannelMessage({ channelId: CHANNEL, token: 't', content: 'x' }, new AbortController().signal)
    expect(reply.retryAfterMs).toBeUndefined()
  })

  it('refuses a response body over the read cap', async () => {
    stubFetch(streamed(['a'.repeat(DISCORD_MAX_RESPONSE_BYTES + 1)]))
    await expect(postChannelMessage({ channelId: CHANNEL, token: 't', content: 'x' }, new AbortController().signal))
      .rejects.toThrow(`discord: response body exceeded ${String(DISCORD_MAX_RESPONSE_BYTES)} bytes`)
  })

  it('accepts a body of exactly the read cap', async () => {
    stubFetch(streamed(['a'.repeat(DISCORD_MAX_RESPONSE_BYTES)]))
    const reply = await postChannelMessage({ channelId: CHANNEL, token: 't', content: 'x' }, new AbortController().signal)
    expect(reply.body).toHaveLength(DISCORD_MAX_RESPONSE_BYTES)
  })

  it('propagates a transport failure from fetch', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')))
    await expect(postChannelMessage({ channelId: CHANNEL, token: 't', content: 'x' }, new AbortController().signal))
      .rejects.toThrow('ECONNREFUSED')
  })
})

describe('openDirectMessageChannel', () => {
  const RECIPIENT = '138391763999129600'

  it('opens the recipient channel and returns its id', async () => {
    const calls = stubFetch(new Response('{"id":"42","type":1}', { status: 200 }))
    const channelId = await openDirectMessageChannel({ recipientId: RECIPIENT, token: 'tok' }, new AbortController().signal)
    expect(channelId).toBe('42')
    expect(calls[0]?.url).toBe(`${DISCORD_API_BASE}/users/@me/channels`)
    expect(calls[0]?.body).toBe(JSON.stringify({ recipient_id: RECIPIENT }))
    expect(calls[0]?.headers.authorization).toBe('Bot tok')
  })

  it('reports Discord own refusal with its status and message', async () => {
    stubFetch(new Response('{"message":"Cannot send messages to this user","code":50007}', { status: 403 }))
    await expect(
      openDirectMessageChannel({ recipientId: RECIPIENT, token: 'tok' }, new AbortController().signal),
    ).rejects.toThrow('discord: cannot open a direct message to 138391763999129600 (HTTP 403: Cannot send messages to this user)')
  })

  it('reports a refusal whose body is not JSON', async () => {
    stubFetch(new Response('<html>gateway unavailable</html>', { status: 502 }))
    await expect(
      openDirectMessageChannel({ recipientId: RECIPIENT, token: 'tok' }, new AbortController().signal),
    ).rejects.toThrow('discord: cannot open a direct message to 138391763999129600 (HTTP 502)')
  })

  it('fails when a successful reply carries no channel id', async () => {
    stubFetch(new Response('{"code":10001}', { status: 200 }))
    await expect(
      openDirectMessageChannel({ recipientId: RECIPIENT, token: 'tok' }, new AbortController().signal),
    ).rejects.toThrow('opening a direct message to 138391763999129600 returned no channel id')
  })

  it('fails when a successful reply is not JSON', async () => {
    stubFetch(new Response('ok', { status: 200 }))
    await expect(
      openDirectMessageChannel({ recipientId: RECIPIENT, token: 'tok' }, new AbortController().signal),
    ).rejects.toThrow('returned no channel id')
  })
})

describe('postTyping', () => {
  it('sends an empty typing request to the channel endpoint', async () => {
    const calls = stubFetch(new Response(null, { status: 204 }))
    await expect(postTyping(CHANNEL, 'secret-token', new AbortController().signal)).resolves.toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${DISCORD_API_BASE}/channels/${CHANNEL}/typing`)
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.headers.authorization).toBe('Bot secret-token')
    expect(calls[0]?.body).toBe('{}')
  })

  it('resolves even when Discord refuses the indicator', async () => {
    stubFetch(new Response('{"message":"Missing Permissions"}', { status: 403 }))
    await expect(postTyping(CHANNEL, 'tok', new AbortController().signal)).resolves.toBeUndefined()
  })

  it('propagates a transport failure so the caller can stop its loop', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')))
    await expect(postTyping(CHANNEL, 'tok', new AbortController().signal)).rejects.toThrow('ECONNREFUSED')
  })
})

describe('discordReplyMessage', () => {
  const reply = (body: string): DiscordPostReply => ({ status: 400, retryAfterMs: undefined, body })

  it('bounds the server message it surfaces', () => {
    expect(discordReplyMessage(reply(`{"message":"${'x'.repeat(400)}"}`))).toHaveLength(300)
  })

  it.each([
    ['empty body', ''],
    ['malformed JSON', '{'],
    ['a JSON array', '[1,2]'],
    ['no message field', '{"code":50001}'],
    ['an empty message', '{"message":""}'],
  ])('finds no message in %s', (_label, body) => {
    expect(discordReplyMessage(reply(body))).toBeUndefined()
  })
})
