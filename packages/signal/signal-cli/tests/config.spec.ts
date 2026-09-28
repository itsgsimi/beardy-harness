import { describe, expect, it } from 'vitest'
import { Config, maskNumber, resolveSpec, SIGNAL_CLI_DEFAULTS } from '../src/index.ts'

describe('resolveSpec', () => {
  it('derives the endpoints and applies every default', () => {
    const spec = resolveSpec({ baseUrl: 'http://127.0.0.1:8820' })
    expect(spec).toEqual({
      baseUrl: 'http://127.0.0.1:8820',
      rpcUrl: new URL('http://127.0.0.1:8820/api/v1/rpc'),
      eventsUrl: new URL('http://127.0.0.1:8820/api/v1/events'),
      checkUrl: new URL('http://127.0.0.1:8820/api/v1/check'),
      ...SIGNAL_CLI_DEFAULTS,
    })
    expect(Config({ baseUrl: 'http://localhost:1' })).toMatchObject(SIGNAL_CLI_DEFAULTS)
  })

  it('keeps an explicit account and bounds', () => {
    const spec = resolveSpec({
      baseUrl: 'http://localhost:8820/', account: '+15551234567', requestTimeoutMs: 500, receive: false,
      reconnectDelayMs: 20, maxReconnectDelayMs: 40, maxMessageChars: 300, outboxMaxPending: 2, outboxMaxChars: 900,
      outboxRetryMs: 10, outboxMaxRetryMs: 30, outboxMaxAttempts: 3, outboxMaxReceipts: 4,
    })
    expect(spec).toMatchObject({
      baseUrl: 'http://localhost:8820', account: '+15551234567', requestTimeoutMs: 500, receive: false,
      reconnectDelayMs: 20, maxReconnectDelayMs: 40, maxMessageChars: 300, outboxMaxPending: 2, outboxMaxChars: 900,
      outboxRetryMs: 10, outboxMaxRetryMs: 30, outboxMaxAttempts: 3, outboxMaxReceipts: 4,
    })
    expect(resolveSpec({ baseUrl: 'http://[::1]:9' }).baseUrl).toBe('http://[::1]:9')
  })

  it.each([
    ['not a url', /is not a URL/],
    ['https://127.0.0.1:8820', /only|must be http/],
    ['http://192.168.1.5:8820', /must be http/],
    ['http://user:pw@127.0.0.1:8820', /must be http/],
    ['http://127.0.0.1:8820/api', /must be http/],
    ['http://127.0.0.1:8820/?x=1', /must be http/],
    ['http://127.0.0.1:8820/#x', /must be http/],
  ])('rejects the daemon root %s', (baseUrl, message) => {
    expect(() => resolveSpec({ baseUrl })).toThrow(message)
  })

  it('rejects a malformed account and inverted ceilings', () => {
    expect(() => resolveSpec({ baseUrl: 'http://127.0.0.1:1', account: '5551234567' })).toThrow('signal-cli: account must be an E.164 number')
    expect(() => resolveSpec({ baseUrl: 'http://127.0.0.1:1', reconnectDelayMs: 50, maxReconnectDelayMs: 20 })).toThrow(/maxReconnectDelayMs/)
    expect(() => resolveSpec({ baseUrl: 'http://127.0.0.1:1', outboxRetryMs: 50, outboxMaxRetryMs: 20 })).toThrow(/outboxMaxRetryMs/)
  })
})

describe('maskNumber', () => {
  it('keeps only the last two digits', () => {
    expect(maskNumber('+15551234512')).toBe('+*********12')
    expect(maskNumber('12')).toBe('+12')
  })
})
