/**
 * Durable camera event history: one record per event with its frames, verdict, reasons, and
 * delivery outcomes, pruned by age and count. Fields added after the first release are optional or
 * defaulted, so earlier records keep parsing under the same domain version.
 * @module @deepseek-ai/dsh-camera-watch/history
 */

import { z } from 'zod'
import { AttachmentId, imageAttachmentRefSchema } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { CameraVerdict } from '@deepseek-ai/dsh-camera'
import { CAMERA_CAPTURE_FAILURES, CAMERA_LABELS, CAMERA_QUESTIONS } from '@deepseek-ai/dsh-camera'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { NOTICE_REASONS, VEHICLE_MOVEMENTS } from './types.ts'

const labels = z.enum(CAMERA_LABELS)
const frameIndex = z.number().int().nonnegative()

/** Activities that records written before rule questions stored. */
export const LEGACY_ACTIVITIES = Object.freeze(['delivering', 'lingering', 'passing', 'ringing', 'none', 'unknown'] as const)

/** Vehicle activities that records written before rule questions stored. */
export const LEGACY_VEHICLE_ACTIVITIES = Object.freeze(['arriving', 'leaving', 'passing', 'parked', 'none', 'unknown'] as const)

/** One stored frame: its durable image reference plus capture offset and source. */
export const historyFrame = imageAttachmentRefSchema.extend({
  offsetMs: z.number().int().nonnegative(),
  source: z.enum(['snapshot', 'stream']),
})

/** One stored answer with its evidence frames. */
export const historyAnswer = z.object({ answer: z.boolean(), frames: z.array(frameIndex) })

/**
 * Stored verdict fields. `answers` is absent from records written before rule questions and reads as
 * empty; those records keep their own `activity`, `vehicleActivity`, `confidence`, and
 * `personFrames`, which no rule reads.
 */
export const historyVerdict = z.object({
  labels: z.array(labels),
  counts: z.partialRecord(labels, z.number().int().min(0).max(99)),
  description: z.string().max(200),
  answers: z.partialRecord(z.enum(CAMERA_QUESTIONS), historyAnswer).default({}),
  activity: z.enum(LEGACY_ACTIVITIES).optional(),
  vehicleActivity: z.enum(LEGACY_VEHICLE_ACTIVITIES).optional(),
  confidence: z.number().min(0).max(1).optional(),
  personFrames: z.array(frameIndex).optional(),
})

/** One event's durable history record. */
export const historyRecord = z.object({
  eventId: z.string().min(1),
  deviceId: z.string().min(1),
  kind: z.enum(['motion', 'ding']),
  occurredAt: z.number(),
  frames: z.array(historyFrame),
  captureFailure: z.enum(CAMERA_CAPTURE_FAILURES).optional(),
  /** Classification Session, when one was opened. */
  sessionId: z.string().optional(),
  status: z.enum(['parsed', 'partial', 'unparsed', 'failed', 'skipped']),
  /** Stable code for a `failed` or `skipped` status. */
  failure: z.string().max(64).optional(),
  verdict: historyVerdict.optional(),
  /** One-line model text for an `unparsed` status, kept for debugging; notices and the `camera` tool never show it. */
  text: z.string().max(200).optional(),
  reasons: z.array(z.enum(NOTICE_REASONS)),
  /**
   * Classified notice outcome: `none` when no classified notice was attempted, because no reason
   * applied or the delivered early notice already stated everything the full check found.
   */
  delivery: z.enum(['none', 'delivered', 'undelivered', 'no-channel']),
  /**
   * Early notice outcome, present when one was attempted before the full classification: the
   * doorbell notice, or the notice from the first motion frame.
   */
  earlyDelivery: z.enum(['delivered', 'undelivered']).optional(),
  /** First-frame classification Session of a motion event, when one was opened. */
  earlySessionId: z.string().optional(),
  /** Reasons the first-frame classification found, present when it answered. */
  earlyReasons: z.array(z.enum(NOTICE_REASONS)).optional(),
  /** Vehicle count movement against {@link baselineEventId}, present when the counts differ. */
  vehicleChange: z.enum(VEHICLE_MOVEMENTS).optional(),
  /** The device's earlier event whose vehicle count or package answer was compared, present when one was. */
  baselineEventId: z.string().optional(),
})

/** Validated history record. */
export type HistoryRecord = z.infer<typeof historyRecord>

/** Validated stored verdict. */
export type HistoryVerdict = z.infer<typeof historyVerdict>

/**
 * Copy a verdict into its stored form.
 * @param verdict - the classification's verdict.
 * @returns the stored verdict fields.
 */
export function storedVerdict(verdict: CameraVerdict): HistoryVerdict {
  return {
    labels: [...verdict.labels],
    counts: { ...verdict.counts },
    description: verdict.description,
    answers: Object.fromEntries(Object.entries(verdict.answers)
      .map(([question, answer]) => [question, { answer: answer.answer, frames: [...answer.frames] }])),
  }
}

/** Validated stored frame. */
export type HistoryFrame = z.infer<typeof historyFrame>

/** Camera watch history in one storage unit; opening requires the declared unit version. */
export const cameraWatchDomainSpec = defineDomain({
  name: 'camera_watch',
  version: 1,
  tables: {
    events: domainTable<string, HistoryRecord>(historyRecord),
  },
})

/** History entries split by the retention bounds. */
export interface HistoryPartition {
  /** Keyed records older than the retention window or beyond the count bound, oldest last. */
  readonly expired: readonly (readonly [string, HistoryRecord])[]
  /** Records the bounds keep. */
  readonly kept: readonly HistoryRecord[]
}

/**
 * Split history by age and count: a record is kept when it is at most `retentionMs` old and among
 * the newest `maxHistory` records.
 * @param entries - keyed history records.
 * @param now - current epoch milliseconds.
 * @param retentionMs - oldest age kept.
 * @param maxHistory - most records kept.
 * @returns the expired and kept records.
 */
export function partitionHistory(
  entries: Iterable<[string, HistoryRecord]>, now: number, retentionMs: number, maxHistory: number,
): HistoryPartition {
  const newestFirst = [...entries].sort((left, right) => right[1].occurredAt - left[1].occurredAt)
  const expired: (readonly [string, HistoryRecord])[] = []
  const kept: HistoryRecord[] = []
  for (const [index, entry] of newestFirst.entries()) {
    if (index < maxHistory && now - entry[1].occurredAt <= retentionMs) kept.push(entry[1])
    else expired.push(entry)
  }
  return { expired, kept }
}

/**
 * Rebuild the durable image reference a stored frame was saved as.
 * @param frame - stored frame.
 * @returns the frame's attachment reference without its capture offset and source.
 */
export function frameAttachment(frame: HistoryFrame): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(frame.attachmentId), mediaType: frame.mediaType, bytes: frame.bytes,
    width: frame.width, height: frame.height,
    ...frame.name === undefined ? {} : { name: frame.name },
    ...frame.originalDimensions === undefined ? {} : { originalDimensions: frame.originalDimensions },
  }
}

/** An earlier event of the same device whose verdict serves as a baseline. */
export interface DeviceBaseline {
  readonly eventId: string
  readonly occurredAt: number
  readonly verdict: CameraVerdict
}

/**
 * Find the baseline for an event: the device's latest earlier record, at most `windowMs` older, with
 * a verdict (only `parsed` and `partial` records have one).
 * @param entries - keyed history records.
 * @param deviceId - the event's device.
 * @param occurredAt - the event's time; the baseline is strictly earlier.
 * @param windowMs - oldest baseline age.
 * @returns the baseline, or undefined when no record qualifies.
 */
export function deviceBaseline(
  entries: Iterable<[string, HistoryRecord]>, deviceId: string, occurredAt: number, windowMs: number,
): DeviceBaseline | undefined {
  let latest: DeviceBaseline | undefined
  for (const [, record] of entries) {
    const { verdict } = record
    if (verdict === undefined || record.deviceId !== deviceId || record.occurredAt >= occurredAt
      || occurredAt - record.occurredAt > windowMs) continue
    if (latest === undefined || record.occurredAt > latest.occurredAt) {
      latest = { eventId: record.eventId, occurredAt: record.occurredAt, verdict }
    }
  }
  return latest
}
