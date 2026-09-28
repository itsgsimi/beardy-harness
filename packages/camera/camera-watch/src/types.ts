/** Camera watch vocabulary: notification reasons, verdict status, and the delivery handoff. @module @deepseek-ai/dsh-camera-watch/types */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** Why an event produced a notification; several can apply to one event. */
export type NoticeReason = 'ding' | 'package' | 'night-person' | 'vehicle' | 'lingering'

/**
 * How far the classifier's answer could be used: `parsed` has every verdict field, `partial` came
 * from a JSON object with missing or invalid fields, `unparsed` had no JSON object, `failed` means
 * the classification turn did not answer, and `skipped` means no classification ran.
 */
export type VerdictStatus = 'parsed' | 'partial' | 'unparsed' | 'failed' | 'skipped'

/** Delivery outcome recorded in history. */
export type NoticeDelivery = 'none' | 'delivered' | 'undelivered' | 'no-channel'

/** One notification handed to the delivery owner, such as the Discord gateway outbox. */
export interface CameraNotice {
  /** Stable delivery identity derived from the event id; a retry reuses it. */
  readonly id: string
  /** Destination Discord channel from validated configuration. */
  readonly channelId: string
  /** Complete notice text of at most 2000 characters. */
  readonly text: string
  /** Stored frame to attach, when the event has frames. */
  readonly image?: ImageAttachmentRef | undefined
}
