/**
 * The daemon's Server-Sent Events stream of received envelopes: validation of each event at this
 * process boundary, conversion of data messages to `signal/message` payloads, and a receiver loop
 * that reconnects with a bounded doubling delay.
 * @module @deepseek-ai/dsh-signal-cli/events
 */

import { EventSourceParserStream } from 'eventsource-parser/stream'
import { z } from 'zod'
import { parseSignalGroupId, parseSignalNumber } from '@deepseek-ai/dsh-delivery-target'
import type { SignalInboundMessage, SignalSender } from '@deepseek-ai/dsh-signal'
import { SignalServiceId } from '@deepseek-ai/dsh-signal'
import { failureText } from './rpc.ts'

/** The `Attachment` fields this provider reads, typed from signal-cli's published schema. */
const attachment = z.object({
  id: z.string().optional(),
  contentType: z.string().optional(),
  filename: z.string().optional(),
  size: z.number().int().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  isVoiceNote: z.boolean(),
})

/** The `DataMessage` fields this provider reads. */
const dataMessage = z.object({
  timestamp: z.number().int(),
  message: z.string().nullish(),
  groupInfo: z.object({ groupId: z.string().optional() }).optional(),
  attachments: z.array(attachment).optional(),
})

/** The `MessageEnvelope` fields this provider reads; other message kinds are ignored. */
const envelope = z.object({
  timestamp: z.number().int(),
  sourceNumber: z.string().nullish(),
  sourceUuid: z.string().optional(),
  sourceName: z.string().optional(),
  dataMessage: dataMessage.optional(),
})

const receiveParams = z.object({ envelope })

/** One event: the receive notification's params, or the whole JSON-RPC notification. */
export const receiveEvent = z.union([
  receiveParams,
  z.object({ jsonrpc: z.literal('2.0'), method: z.literal('receive'), params: receiveParams }),
])

/** Outcome of reading one event's data. */
export type ParsedEvent =
  | { readonly kind: 'message'; readonly message: SignalInboundMessage }
  | { readonly kind: 'ignored' }
  | { readonly kind: 'invalid'; readonly reason: string }

function sender(source: z.infer<typeof envelope>): SignalSender {
  const number = source.sourceNumber == null ? undefined : parseSignalNumber(source.sourceNumber)
  let serviceId: ReturnType<typeof SignalServiceId> | undefined
  if (source.sourceUuid !== undefined) {
    try {
      serviceId = SignalServiceId(source.sourceUuid)
    } catch {
      // A non-UUID service id identifies nobody this harness can address; the number may still.
      serviceId = undefined
    }
  }
  return {
    ...number === undefined ? {} : { number },
    ...serviceId === undefined ? {} : { serviceId },
    ...source.sourceName === undefined || source.sourceName === '' ? {} : { name: source.sourceName },
  }
}

/**
 * Read one event's data: a data message with text or attachments becomes a `signal/message`
 * payload; receipts, typing, sync, and reaction-only envelopes are ignored.
 * @param data - the event's `data` field.
 * @returns the message, an ignored envelope, or why the data was invalid.
 */
export function parseEvent(data: string): ParsedEvent {
  let json: unknown
  try {
    json = JSON.parse(data)
  } catch {
    // The parser's SyntaxError names an offset in content that is never logged.
    return { kind: 'invalid', reason: 'the event is not JSON' }
  }
  const parsed = receiveEvent.safeParse(json)
  if (!parsed.success) return { kind: 'invalid', reason: 'the event is not a receive notification' }
  const source = 'params' in parsed.data ? parsed.data.params.envelope : parsed.data.envelope
  const message = source.dataMessage
  const text = message?.message ?? ''
  const attachments = message?.attachments ?? []
  if (message === undefined || (text === '' && attachments.length === 0)) return { kind: 'ignored' }
  const rawGroupId = message.groupInfo?.groupId
  const groupId = rawGroupId === undefined ? undefined : parseSignalGroupId(rawGroupId)
  if (rawGroupId !== undefined && groupId === undefined) return { kind: 'invalid', reason: 'the group id is not base64 of 32 bytes' }
  return {
    kind: 'message',
    message: {
      sender: sender(source),
      ...groupId === undefined ? {} : { groupId },
      text,
      timestamp: message.timestamp,
      attachments: attachments.map(item => ({
        ...item.id === undefined ? {} : { id: item.id },
        ...item.contentType === undefined ? {} : { contentType: item.contentType },
        ...item.filename === undefined ? {} : { filename: item.filename },
        ...item.size === undefined ? {} : { size: item.size },
        ...item.width === undefined ? {} : { width: item.width },
        ...item.height === undefined ? {} : { height: item.height },
        voiceNote: item.isVoiceNote,
      })),
    },
  }
}

/** Everything the receiver loop needs. */
export interface ReceiverOptions {
  readonly eventsUrl: URL
  readonly fetch: typeof globalThis.fetch
  readonly reconnectDelayMs: number
  readonly maxReconnectDelayMs: number
  /** Ends the loop and the open stream. */
  readonly signal: AbortSignal
  /** Waits between connection attempts; rejects when `signal` aborts. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  /** Publishes one message; awaited before the next event is read. */
  readonly publish: (message: SignalInboundMessage) => Promise<void>
  readonly warn: (line: string) => void
  readonly debug: (line: string) => void
}

async function consume(body: ReadableStream<BufferSource>, options: ReceiverOptions): Promise<void> {
  const events = body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream())
  for await (const event of events) {
    const parsed = parseEvent(event.data)
    if (parsed.kind === 'message') await options.publish(parsed.message)
    else if (parsed.kind === 'invalid') options.warn(`signal-cli: skipped an event: ${parsed.reason}`)
    else options.debug('signal-cli: ignored an envelope without message text or attachments')
  }
}

/**
 * Hold the event stream open until `signal` aborts, reconnecting after each failure or end of
 * stream with a delay that starts at `reconnectDelayMs`, doubles up to `maxReconnectDelayMs`, and
 * resets once a connection opens.
 * @param options - endpoint, delays, publisher, and logging.
 */
export async function runReceiver(options: ReceiverOptions): Promise<void> {
  const stopped = (): boolean => options.signal.aborted
  let wait = options.reconnectDelayMs
  while (!stopped()) {
    try {
      const response = await options.fetch(options.eventsUrl, { headers: { accept: 'text/event-stream' }, signal: options.signal })
      if (response.status !== 200) {
        await response.arrayBuffer()
        throw new Error(`event stream answered HTTP ${String(response.status)}`)
      }
      wait = options.reconnectDelayMs
      // A 200 response to a GET always carries a body stream.
      await consume(response.body as NonNullable<Response['body']>, options)
      options.warn(`signal-cli: event stream ended; reconnecting in ${String(wait)} ms`)
    } catch (error: unknown) {
      if (stopped()) return
      options.warn(`signal-cli: event stream failed (${failureText(error)}); reconnecting in ${String(wait)} ms`)
    }
    try {
      await options.sleep(wait, options.signal)
    } catch {
      // Only disposal aborts this delay, and disposal ends the loop.
      return
    }
    wait = Math.min(wait * 2, options.maxReconnectDelayMs)
  }
}
