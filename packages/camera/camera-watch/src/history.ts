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
import { CAMERA_ACTIVITIES, CAMERA_CAPTURE_FAILURES, CAMERA_LABELS, CAMERA_VEHICLE_ACTIVITIES } from '@deepseek-ai/dsh-camera'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { NOTICE_REASONS } from './types.ts'

const labels = z.enum(CAMERA_LABELS)

/** One stored frame: its durable image reference plus capture offset and source. */
export const historyFrame = imageAttachmentRefSchema.extend({
  offsetMs: z.number().int().nonnegative(),
  source: z.enum(['snapshot', 'stream']),
})

/** Stored verdict fields. */
export const historyVerdict = z.object({
  labels: z.array(labels),
  counts: z.partialRecord(labels, z.number().int().min(0).max(99)),
  activity: z.enum(CAMERA_ACTIVITIES),
  /** Absent from records written before vehicle activity existed; those read as `unknown`. */
  vehicleActivity: z.enum(CAMERA_VEHICLE_ACTIVITIES).default('unknown'),
  confidence: z.number().min(0).max(1),
  description: z.string().max(200),
  personFrames: z.array(z.number().int().nonnegative()),
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
  /** One-line model text for an `unparsed` status. */
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
  vehicleChange: z.enum(['arriving', 'leaving']).optional(),
  /** The device's previous event whose vehicle count was compared, present with {@link vehicleChange}. */
  baselineEventId: z.string().optional(),
})

/** Validated history record. */
export type HistoryRecord = z.infer<typeof historyRecord>

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

/** An earlier event whose verdict serves as a vehicle-count baseline. */
export interface VehicleBaseline {
  readonly eventId: string
  readonly occurredAt: number
  readonly verdict: CameraVerdict
}

/**
 * Find the vehicle-count baseline for an event: the device's latest earlier record, at most
 * `windowMs` older, with a verdict (only `parsed` and `partial` records have one) that reaches `minConfidence`.
 * @param entries - keyed history records.
 * @param deviceId - the event's device.
 * @param occurredAt - the event's time; the baseline is strictly earlier.
 * @param windowMs - oldest baseline age.
 * @param minConfidence - lowest trusted baseline confidence.
 * @returns the baseline, or undefined when no record qualifies.
 */
export function vehicleBaseline(
  entries: Iterable<[string, HistoryRecord]>, deviceId: string, occurredAt: number, windowMs: number, minConfidence: number,
): VehicleBaseline | undefined {
  let latest: VehicleBaseline | undefined
  for (const [, record] of entries) {
    const { verdict } = record
    if (verdict === undefined || record.deviceId !== deviceId || record.occurredAt >= occurredAt
      || occurredAt - record.occurredAt > windowMs || verdict.confidence < minConfidence) continue
    if (latest === undefined || record.occurredAt > latest.occurredAt) {
      latest = { eventId: record.eventId, occurredAt: record.occurredAt, verdict }
    }
  }
  return latest
}
