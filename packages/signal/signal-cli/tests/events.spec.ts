import { afterEach, describe, expect, it } from 'vitest'
import type { SignalInboundMessage } from '@deepseek-ai/dsh-signal'
import { parseEvent, runReceiver } from '../src/events.ts'
import type { ReceiverOptions } from '../src/events.ts'
import { fakeDaemon, until } from './support.ts'
import type { FakeDaemon } from './support.ts'

const GROUP = Buffer.alloc(32, 6).toString('base64')
const UUID = 'A1B2C3D4-0000-4000-8000-00000000000F'

function envelope(dataMessage: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: 10, serverReceivedTimestamp: 11, serverDeliveredTimestamp: 12, source: '+15551234567', sourceNumber: '+15551234567',
    sourceUuid: UUID, sourceName: 'Goran', sourceDevice: 1, ...dataMessage === undefined ? {} : { dataMessage }, ...extra,
  }
}

describe('parseEvent', () => {
  it('reads a group data message with attachments from receive params', () => {
    const data = JSON.stringify({ account: '+15550001234', envelope: envelope({
      timestamp: 99, message: 'hello', groupInfo: { groupId: GROUP, groupName: 'Home', revision: 3, type: 'DELIVER' },
      attachments: [
        { id: 'att1', contentType: 'image/jpeg', filename: 'a.jpg', size: 12, width: 4, height: 3, isVoiceNote: false },
        { isVoiceNote: true },
      ],
    }) })
    expect(parseEvent(data)).toEqual({ kind: 'message', message: {
      sender: { number: '+15551234567', serviceId: UUID.toLowerCase(), name: 'Goran' },
      groupId: GROUP, text: 'hello', timestamp: 99,
      attachments: [
        { id: 'att1', contentType: 'image/jpeg', filename: 'a.jpg', size: 12, width: 4, height: 3, voiceNote: false },
        { voiceNote: true },
      ],
    } })
  })

  it('reads a direct message from a full JSON-RPC notification and tolerates hidden sender fields', () => {
    const data = JSON.stringify({ jsonrpc: '2.0', method: 'receive', params: { envelope: {
      timestamp: 1, serverReceivedTimestamp: 1, serverDeliveredTimestamp: 1, sourceNumber: null, sourceUuid: 'not-a-uuid', sourceName: '',
      dataMessage: { timestamp: 7, message: 'hi' },
    } } })
    expect(parseEvent(data)).toEqual({ kind: 'message', message: { sender: {}, text: 'hi', timestamp: 7, attachments: [] } })
    const bare = JSON.stringify({ envelope: { timestamp: 1, dataMessage: { timestamp: 8, message: 'yo' } } })
    expect(parseEvent(bare)).toMatchObject({ kind: 'message', message: { sender: {}, text: 'yo' } })
  })

  it('ignores envelopes without message text or attachments', () => {
    expect(parseEvent(JSON.stringify({ envelope: envelope(undefined, { receiptMessage: { when: 1, isDelivery: true } }) }))).toEqual({ kind: 'ignored' })
    expect(parseEvent(JSON.stringify({ envelope: envelope({ timestamp: 1, message: null, reaction: { emoji: '👍' } }) }))).toEqual({ kind: 'ignored' })
  })

  it('reports invalid data without its content', () => {
    expect(parseEvent('{oops')).toEqual({ kind: 'invalid', reason: 'the event is not JSON' })
    expect(parseEvent(JSON.stringify({ jsonrpc: '2.0', method: 'other', params: {} }))).toEqual({ kind: 'invalid', reason: 'the event is not a receive notification' })
    expect(parseEvent(JSON.stringify({ envelope: envelope({ timestamp: 1, message: 'x', groupInfo: { groupId: 'short', revision: 1 } }) })))
      .toEqual({ kind: 'invalid', reason: 'the group id is not base64 of 32 bytes' })
  })
})

describe('runReceiver', () => {
  let daemon: FakeDaemon | undefined
  afterEach(async () => { await daemon?.close() })

  function options(overrides: Partial<ReceiverOptions>, received: SignalInboundMessage[], logs: string[]): ReceiverOptions {
    return {
      eventsUrl: new URL('/api/v1/events', daemon!.baseUrl), fetch: globalThis.fetch, reconnectDelayMs: 10, maxReconnectDelayMs: 25,
      signal: new AbortController().signal,
      sleep: (ms) => { logs.push(`sleep ${String(ms)}`); return new Promise(resolve => setTimeout(resolve, 1)) },
      publish: async (message) => { received.push(message) },
      warn: (line) => { logs.push(line) },
      debug: (line) => { logs.push(`debug: ${line}`) },
      ...overrides,
    }
  }

  it('publishes data messages, skips invalid events, reconnects with a bounded doubling delay, and stops on abort', async () => {
    daemon = await fakeDaemon()
    daemon.eventStatuses.push(503, 503, 503)
    const controller = new AbortController()
    const received: SignalInboundMessage[] = []
    const logs: string[] = []
    const running = runReceiver(options({ signal: controller.signal }, received, logs))
    await daemon.streamOpen()
    expect(logs.slice(0, 6)).toEqual([
      'signal-cli: event stream failed (event stream answered HTTP 503); reconnecting in 10 ms', 'sleep 10',
      'signal-cli: event stream failed (event stream answered HTTP 503); reconnecting in 20 ms', 'sleep 20',
      'signal-cli: event stream failed (event stream answered HTTP 503); reconnecting in 25 ms', 'sleep 25',
    ])
    daemon.push(JSON.stringify({ envelope: envelope({ timestamp: 5, message: 'one' }) }))
    daemon.push('not json')
    daemon.push(JSON.stringify({ envelope: envelope(undefined) }))
    await until(() => logs.some(line => line.startsWith('debug:')))
    expect(received.map(message => message.text)).toEqual(['one'])
    expect(logs).toContain('signal-cli: skipped an event: the event is not JSON')
    logs.length = 0
    daemon.endStreams()
    await daemon.streamOpen()
    expect(logs).toEqual(['signal-cli: event stream ended; reconnecting in 10 ms', 'sleep 10'])
    daemon.push(JSON.stringify({ envelope: envelope({ timestamp: 6, message: 'two' }) }))
    await until(() => received.length === 2)
    controller.abort()
    await running
    expect(daemon.eventConnections).toBe(5)
  })

  it('returns at once when already aborted and when a delay is aborted', async () => {
    daemon = await fakeDaemon()
    const aborted = AbortSignal.abort()
    const logs: string[] = []
    await runReceiver(options({ signal: aborted }, [], logs))
    expect(daemon.eventConnections).toBe(0)
    daemon.eventStatuses.push(503)
    await runReceiver(options({ sleep: async () => { throw new Error('aborted') } }, [], logs))
    expect(logs).toEqual(['signal-cli: event stream failed (event stream answered HTTP 503); reconnecting in 10 ms'])
  })

  it('stops quietly when disposal aborts an open stream', async () => {
    daemon = await fakeDaemon()
    const controller = new AbortController()
    const logs: string[] = []
    const running = runReceiver(options({ signal: controller.signal }, [], logs))
    await daemon.streamOpen()
    controller.abort()
    await running
    expect(logs).toEqual([])
  })
})
