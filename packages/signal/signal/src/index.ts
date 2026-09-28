/**
 * Signal service definition: durable outbound messages to a group or an account, provider health,
 * and inbound data messages as `signal/message`. Branded ids and target parsing come from
 * `@deepseek-ai/dsh-delivery-target`, which producers use without depending on this capability.
 * @module @deepseek-ai/dsh-signal
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import { parseSignalGroupId, parseSignalNumber } from '@deepseek-ai/dsh-delivery-target'
import type {
  SignalDeliveryId as SignalDeliveryIdType, SignalDeliveryResult, SignalGroupId as SignalGroupIdType, SignalHealth,
  SignalInboundMessage, SignalNumber as SignalNumberType, SignalSendRequest, SignalServiceId as SignalServiceIdType,
} from './types.ts'

export type * from './types.ts'

/**
 * Validate a Signal group id: canonical standard base64 of 32 bytes.
 * @param value - candidate id.
 * @returns branded group id.
 */
export function SignalGroupId(value: string): SignalGroupIdType {
  const groupId = parseSignalGroupId(value)
  if (groupId === undefined) throw new Error('Signal group id must be the standard base64 of 32 bytes')
  return groupId
}

/**
 * Validate an E.164 phone number.
 * @param value - candidate number.
 * @returns branded number.
 */
export function SignalNumber(value: string): SignalNumberType {
  const number = parseSignalNumber(value)
  if (number === undefined) throw new Error('Signal number must be E.164, such as +15551234567')
  return number
}

/**
 * Validate a Signal service id: a UUID, compared in lowercase.
 * @param value - candidate id.
 * @returns branded lowercase service id.
 */
export function SignalServiceId(value: string): SignalServiceIdType {
  const lower = value.toLowerCase()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(lower)) throw new Error('Signal service id must be a UUID')
  return brandString<SignalServiceIdType>(lower)
}

/**
 * Validate a delivery id: 1 to 200 printable characters without whitespace.
 * @param value - producer-chosen identity, such as `camera:ring-1-2`.
 * @returns branded delivery id.
 */
export function SignalDeliveryId(value: string): SignalDeliveryIdType {
  if (!/^[\x21-\x7e]{1,200}$/u.test(value)) throw new Error('Signal delivery id must be 1 to 200 printable ASCII characters without spaces')
  return brandString<SignalDeliveryIdType>(value)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Active Signal provider. */
    signal: SignalService
  }
  interface Events {
    /**
     * One inbound data message from another account. Listeners should enqueue work and return; the
     * provider awaits every listener before the next message and logs failures without retrying.
     * @param message - sender, group, text, timestamp, and attachment metadata.
     * @mode parallel
     */
    'signal/message'(message: SignalInboundMessage): void | Promise<void>
  }
}

/** Provider-neutral Signal capability; one provider owns `ctx.signal`. */
export abstract class SignalService extends Service {
  constructor(ctx: Context) {
    if (new.target === SignalService) throw new Error('load a Signal provider, not the abstract definition')
    super(ctx, 'signal')
  }

  /**
   * Accept one outbound message durably; transmission and its retries happen afterwards.
   * @param request - delivery id, destination, text, and optional stored image.
   * @returns the delivery id and whether it was newly queued or already accepted.
   * @throws Error when the message is empty, too long, or the queue is full or stopping.
   */
  abstract send(request: SignalSendRequest): Promise<SignalDeliveryResult>

  /**
   * Check the transport now and report the outbound queue.
   * @returns reachability, masked account, and pending deliveries.
   */
  abstract health(): Promise<SignalHealth>

  /**
   * Hand one inbound message to every `signal/message` listener, logging each listener failure so
   * one broken consumer never stops the receiver or its other consumers.
   * @param message - validated inbound message.
   */
  protected async publishMessage(message: SignalInboundMessage): Promise<void> {
    try {
      await this.ctx.parallel('signal/message', message)
    } catch (error: unknown) {
      /* v8 ignore next -- Context.parallel rejects only with an AggregateError of listener failures. */
      const reasons: unknown[] = error instanceof AggregateError ? error.errors : [error]
      for (const reason of reasons) {
        const cause = reason instanceof Error ? reason.message : String(reason)
        this.ctx.logger.warn(`signal: a signal/message listener failed for message ${String(message.timestamp)}: ${cause}`)
      }
    }
  }
}

export default SignalService
