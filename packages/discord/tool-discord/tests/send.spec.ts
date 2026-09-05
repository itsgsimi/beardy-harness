import { describe, expect, it } from 'vitest'
import type { DiscordPostReply } from '../src/http.ts'
import type { DiscordSenderOptions } from '../src/send.ts'
import { defangBroadcastMentions, sendDiscordMessage } from '../src/send.ts'

const CHANNEL = '1478276183543119914'

/** One accepted reply; the transport fixture returns these in order. */
function accepted(): DiscordPostReply {
  return { status: 201, retryAfterMs: undefined, body: '{"id":"1"}' }
}

/** Recorded fixtures for the two seams the sender uses. */
function fixture(replies: readonly DiscordPostReply[], overrides: Partial<DiscordSenderOptions> = {}) {
  const posted: string[] = []
  const waited: number[] = []
  const options: DiscordSenderOptions = {
    channel: CHANNEL,
    requestTimeoutMs: 1_000,
    maxRetries: 2,
    maxRetryWaitMs: 5_000,
    maxChunksPerCall: 5,
    post: async (request) => {
      const reply = replies[posted.length] ?? accepted()
      posted.push(request.content)
      return reply
    },
    wait: async (ms) => {
      waited.push(ms)
    },
    ...overrides,
  }
  return { options, posted, waited }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

describe('defangBroadcastMentions', () => {
  it('leaves content without broadcast mentions untouched', () => {
    expect(defangBroadcastMentions('no pings here')).toEqual({ content: 'no pings here', count: 0 })
  })

  it('rewrites every @everyone and @here occurrence', () => {
    const rewritten = defangBroadcastMentions('@everyone read this, and @here too')
    expect(rewritten.count).toBe(2)
    expect(rewritten.content).not.toContain('@everyone')
    expect(rewritten.content).not.toContain('@here')
    expect(rewritten.content).toBe('@\u200beveryone read this, and @\u200bhere too')
  })
})

describe('sendDiscordMessage', () => {
  it('posts one short body and reports its length', async () => {
    const { options, posted } = fixture([accepted()])
    const result = await sendDiscordMessage(options, 'token', 'Morning brief: sunny.', signal())
    expect(posted).toEqual(['Morning brief: sunny.'])
    expect(result).toEqual({ chunks: 1, characters: 21, suppressedBroadcastMentions: 0 })
  })

  it('defangs broadcast mentions before posting', async () => {
    const { options, posted } = fixture([accepted()])
    const result = await sendDiscordMessage(options, 'token', '@everyone: sunny today', signal())
    expect(posted[0]).toBe('@\u200beveryone: sunny today')
    expect(result.suppressedBroadcastMentions).toBe(1)
  })

  it('posts several messages in order for a body over the protocol limit', async () => {
    const long = Array.from({ length: 700 }, (_unused, index) => `w${String(index)}`).join(' ')
    const { options, posted } = fixture([accepted(), accepted(), accepted()])
    const result = await sendDiscordMessage(options, 'token', long, signal())
    expect(result.chunks).toBeGreaterThan(1)
    expect(posted.length).toBe(result.chunks)
    expect(result.characters).toBe(posted.reduce((total, chunk) => total + chunk.length, 0))
  })

  it('refuses a body that would need more messages than the configured cap', async () => {
    const long = 'x'.repeat(6_000)
    const { options, posted } = fixture([], { maxChunksPerCall: 2 })
    await expect(sendDiscordMessage(options, 'token', long, signal())).rejects.toThrow(
      'message needs 3 Discord messages, above the configured limit of 2 (6000 characters)',
    )
    expect(posted).toEqual([])
  })

  it('refuses a body with no text', async () => {
    const { options } = fixture([])
    await expect(sendDiscordMessage(options, 'token', '   \n  ', signal())).rejects.toThrow(
      'discord_send requires a non-empty message body',
    )
  })

  it('reports Discord own reason for a refused post', async () => {
    const { options } = fixture([{ status: 403, retryAfterMs: undefined, body: '{"message":"Missing Permissions"}' }])
    await expect(sendDiscordMessage(options, 'token', 'hello', signal())).rejects.toThrow(
      'discord API returned HTTP 403: Missing Permissions',
    )
  })

  it('reports only the status when the error body is not JSON', async () => {
    const { options } = fixture([{ status: 500, retryAfterMs: undefined, body: '<html>cloudflare</html>' }])
    await expect(sendDiscordMessage(options, 'token', 'hello', signal())).rejects.toThrow(
      'discord API returned HTTP 500',
    )
  })

  it('waits out a rate limit using the JSON retry_after field, then succeeds', async () => {
    const { options, posted, waited } = fixture([
      { status: 429, retryAfterMs: undefined, body: '{"retry_after":1.5,"global":false}' },
      accepted(),
    ])
    const result = await sendDiscordMessage(options, 'token', 'hello', signal())
    expect(waited).toEqual([1500])
    expect(posted).toEqual(['hello', 'hello'])
    expect(result.chunks).toBe(1)
  })

  it('falls back to the Retry-After header when the body carries no delay', async () => {
    const { options, waited } = fixture([{ status: 429, retryAfterMs: 2_500, body: '' }, accepted()])
    await sendDiscordMessage(options, 'token', 'hello', signal())
    expect(waited).toEqual([2500])
  })

  it('refuses a rate limit that names no delay at all', async () => {
    const { options } = fixture([{ status: 429, retryAfterMs: undefined, body: '{}' }])
    await expect(sendDiscordMessage(options, 'token', 'hello', signal())).rejects.toThrow(
      'discord rate limit reply carried no retry delay',
    )
  })

  it('refuses a rate-limit delay above the configured wait cap', async () => {
    const { options, waited } = fixture([{ status: 429, retryAfterMs: 60_000, body: '' }, accepted()], { maxRetryWaitMs: 5_000 })
    await expect(sendDiscordMessage(options, 'token', 'hello', signal())).rejects.toThrow(
      'discord rate limit asks for 60000ms, above the configured 5000ms',
    )
    expect(waited).toEqual([])
  })

  it('gives up after the configured retry count and reports the rate-limit reply', async () => {
    const rateLimited: DiscordPostReply = { status: 429, retryAfterMs: 10, body: '{"message":"slow down"}' }
    const { options, waited } = fixture([rateLimited, rateLimited, rateLimited])
    await expect(sendDiscordMessage(options, 'token', 'hello', signal())).rejects.toThrow(
      'discord API returned HTTP 429: slow down',
    )
    expect(waited).toEqual([10, 10])
  })

  it('translates an expired attempt deadline into a timeout message', async () => {
    const { options } = fixture([], {
      requestTimeoutMs: 20,
      post: (_request, attemptSignal) => new Promise<DiscordPostReply>((_resolve, reject) => {
        attemptSignal.addEventListener('abort', () => {
          reject(new Error('transport aborted'))
        }, { once: true })
      }),
    })
    await expect(sendDiscordMessage(options, 'token', 'hello', signal())).rejects.toThrow('discord_send timed out after 20ms')
  })

  it('propagates a transport failure that is not a timeout', async () => {
    const { options } = fixture([], {
      post: async () => {
        throw new Error('ECONNRESET')
      },
    })
    await expect(sendDiscordMessage(options, 'token', 'hello', signal())).rejects.toThrow('ECONNRESET')
  })
})
