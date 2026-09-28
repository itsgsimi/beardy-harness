/** Camera watch vocabulary: notification reasons, verdict status, and the delivery handoff. @module @deepseek-ai/dsh-camera-watch/types */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** Notification reasons in canonical order; several can apply to one event. */
export const NOTICE_REASONS = ['ding', 'package', 'night-person', 'person', 'vehicle', 'lingering'] as const

/** Why an event produced a notification. */
export type NoticeReason = typeof NOTICE_REASONS[number]

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
  /** Stable delivery identity derived from the event id, or from the window of a classification failure notice; a retry reuses it. */
  readonly id: string
  /** Validated delivery target from configuration; each delivery owner claims only its own transport's targets. */
  readonly channelId: string
  /** Complete notice text of at most 2000 characters. */
  readonly text: string
  /** Stored frame to attach, when the event has frames. */
  readonly image?: ImageAttachmentRef | undefined
}
