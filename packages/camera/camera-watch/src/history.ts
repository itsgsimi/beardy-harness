/**
 * Durable camera event history: one record per event with its frames, verdict, reasons, and
 * delivery outcome, pruned by age and count.
 * @module @deepseek-ai/dsh-camera-watch/history
 */

import { z } from 'zod'
import { CAMERA_ACTIVITIES, CAMERA_LABELS } from '@deepseek-ai/dsh-camera'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'

const labels = z.enum(CAMERA_LABELS)
const dimensions = z.object({ width: z.number().int().positive(), height: z.number().int().positive() })

/** One stored frame: its durable image reference plus capture offset and source. */
export const historyFrame = z.object({
  attachmentId: z.string().min(1),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  bytes: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  name: z.string().optional(),
  originalDimensions: dimensions.optional(),
  offsetMs: z.number().int().nonnegative(),
  source: z.enum(['snapshot', 'stream']),
})

/** Stored verdict fields. */
export const historyVerdict = z.object({
  labels: z.array(labels),
  counts: z.partialRecord(labels, z.number().int().min(0).max(99)),
  activity: z.enum(CAMERA_ACTIVITIES),
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
  captureFailure: z.enum(['snapshot-unavailable', 'stream-failed', 'storage-failed']).optional(),
  /** Classification Session, when one was opened. */
  sessionId: z.string().optional(),
  status: z.enum(['parsed', 'partial', 'unparsed', 'failed', 'skipped']),
  /** Stable code for a `failed` or `skipped` status. */
  failure: z.string().max(64).optional(),
  verdict: historyVerdict.optional(),
  /** One-line model text for an `unparsed` status. */
  text: z.string().max(200).optional(),
  reasons: z.array(z.enum(['ding', 'package', 'night-person', 'vehicle', 'lingering'])),
  delivery: z.enum(['none', 'delivered', 'undelivered', 'no-channel']),
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

/**
 * Delete records older than the retention window, then the oldest records beyond the count bound.
 * @param table - history table.
 * @param now - current epoch milliseconds.
 * @param retentionMs - oldest age kept.
 * @param maxHistory - most records kept.
 * @returns number of deleted records.
 */
export async function sweepHistory(
  table: KvTable<string, HistoryRecord>, now: number, retentionMs: number, maxHistory: number,
): Promise<number> {
  const newestFirst = [...table.entries()].sort((left, right) => right[1].occurredAt - left[1].occurredAt)
  let removed = 0
  for (const [index, [key, record]] of newestFirst.entries()) {
    if (index < maxHistory && now - record.occurredAt <= retentionMs) continue
    await table.delete(key)
    removed++
  }
  return removed
}
