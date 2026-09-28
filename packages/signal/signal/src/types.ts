/** Signal capability types shared by providers and consumers. @module @deepseek-ai/dsh-signal/types */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SignalDeliveryTarget, SignalGroupId, SignalNumber } from '@deepseek-ai/dsh-delivery-target'

export type { SignalGroupId, SignalNumber }

/** A Signal destination: one group or one account by phone number. */
export type SignalTarget = SignalDeliveryTarget

/** Signal account service id (ACI), a lowercase UUID. */
export type SignalServiceId = Branded<'SignalServiceId'>

/** Idempotency key of one outbound delivery. */
export type SignalDeliveryId = Branded<'SignalDeliveryId'>

/** One outbound message. */
export interface SignalSendRequest {
  /**
   * Stable delivery identity; a request repeating an accepted id is not queued again. Absent, the
   * provider assigns a fresh id, so a retried call can deliver twice.
   */
  readonly id?: SignalDeliveryId
  /** Destination group or account. */
  readonly target: SignalTarget
  /**
   * Complete message text. Paired `**bold**` markers become native bold styles; providers split text
   * longer than one Signal message into ordered parts.
   */
  readonly text: string
  /** Stored image sent with the first part; an unreadable image leaves the text-only message. */
  readonly image?: ImageAttachmentRef
}

/** How a provider took one outbound message. */
export interface SignalDeliveryResult {
  /** Delivery identity, the request's or an assigned one. */
  readonly id: SignalDeliveryId
  /** `queued` after durable acceptance; `duplicate` when the id was already accepted. */
  readonly state: 'queued' | 'duplicate'
}

/** Provider connectivity and queue state. */
export interface SignalHealth {
  /** Whether the provider's transport answered its liveness check. */
  readonly reachable: boolean
  /** Connected account with every digit but the last two masked, when the transport reports it. */
  readonly account?: string
  /** Epoch milliseconds of the check. */
  readonly checkedAt: number
  /** Short failure cause when unreachable. */
  readonly detail?: string
  /** Accepted deliveries not yet sent or abandoned. */
  readonly pending: number
}

/** Metadata of one inbound attachment; content is not fetched. */
export interface SignalAttachmentInfo {
  /** Transport-assigned attachment id. */
  readonly id?: string
  /** Declared media type. */
  readonly contentType?: string
  /** Sender-supplied file name. */
  readonly filename?: string
  /** Declared byte size. */
  readonly size?: number
  /** Pixel width for images and video. */
  readonly width?: number
  /** Pixel height for images and video. */
  readonly height?: number
  /** Whether the sender recorded it as a voice note. */
  readonly voiceNote: boolean
}

/** Who sent an inbound message; a sender may hide the phone number. */
export interface SignalSender {
  /** Sender phone number, when shared. */
  readonly number?: SignalNumber
  /** Sender service id, when reported. */
  readonly serviceId?: SignalServiceId
  /** Sender profile name, when reported. */
  readonly name?: string
}

/** One inbound data message from another account. */
export interface SignalInboundMessage {
  /** Sender identity. */
  readonly sender: SignalSender
  /** Group the message was posted in; absent for a direct message. */
  readonly groupId?: SignalGroupId
  /** Message body; empty for an attachment-only message. */
  readonly text: string
  /** Sender's message timestamp in epoch milliseconds, Signal's message identity with the sender. */
  readonly timestamp: number
  /** Attachment metadata in message order. */
  readonly attachments: readonly SignalAttachmentInfo[]
}
