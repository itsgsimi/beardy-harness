/** Read-only `camera` model tool over the event history. @module @deepseek-ai/dsh-camera-watch/tool */

import type { CameraDevice } from '@deepseek-ai/dsh-camera'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { defineTool, TEXT_TOOL_OUTPUT } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { HistoryRecord } from './history.ts'
import { localDateTime } from './notice.ts'

/** Model-facing tool name. */
export const CAMERA_TOOL_NAME = 'camera'

/** What the tool reads and how much it may return. */
export interface CameraToolOptions {
  /** History table; the tool only enumerates it. */
  readonly table: Pick<KvTable<string, HistoryRecord>, 'entries'>
  readonly devices: readonly CameraDevice[]
  readonly timezone: string
  /** Most events one result lists. */
  readonly maxEvents: number
  /** Oldest history the retention window keeps, in hours. */
  readonly maxHours: number
  readonly now: () => number
}

/** One event as the model reads it. */
export interface CameraToolEvent {
  readonly id: string
  readonly time: string
  readonly camera: string
  readonly kind: 'motion' | 'ding'
  readonly description: string
  readonly labels: readonly string[]
  readonly counts: Readonly<Record<string, number>>
  /** Each answered question and its answer; absent for records classified before rule questions. */
  readonly answers?: Readonly<Record<string, boolean>>
  /** Stored only by records classified before rule questions. */
  readonly activity?: string
  /** Stored only by records classified before rule questions. */
  readonly vehicleActivity?: string
  /** Stored only by records classified before rule questions. */
  readonly confidence?: number
  readonly checked: string
  readonly notified: boolean
  readonly reasons: readonly string[]
}

/** Whether any notice for the record reached its delivery owner. */
function notified(record: HistoryRecord): boolean {
  return record.delivery === 'delivered' || record.earlyDelivery === 'delivered'
}

/** Answers of a record classified with rule questions, or the stored fields of an earlier record. */
function verdictFields(verdict: NonNullable<HistoryRecord['verdict']>): Partial<CameraToolEvent> {
  const { activity, vehicleActivity, confidence } = verdict
  if (activity !== undefined) {
    return { activity, ...vehicleActivity === undefined ? {} : { vehicleActivity }, ...confidence === undefined ? {} : { confidence } }
  }
  return { answers: Object.fromEntries(Object.entries(verdict.answers).map(([question, answer]) => [question, answer.answer])) }
}

function modelEvent(record: HistoryRecord, labels: ReadonlyMap<string, string>, timezone: string): CameraToolEvent {
  const verdict = record.verdict
  return {
    id: record.eventId,
    time: localDateTime(record.occurredAt, timezone),
    camera: labels.get(record.deviceId) ?? record.deviceId,
    kind: record.kind,
    description: verdict?.description ?? record.text ?? (record.frames.length === 0 ? 'No picture was captured.' : 'Not described.'),
    labels: verdict?.labels ?? [],
    counts: verdict?.counts ?? {},
    ...verdict === undefined ? {} : verdictFields(verdict),
    checked: record.failure === undefined ? record.status : `${record.status} (${record.failure})`,
    notified: notified(record),
    reasons: record.reasons,
  }
}

/**
 * Build the read-only `camera` tool. Results list events newest first within the requested window.
 * @param options - history, devices, zone, bounds, and clock.
 * @returns registry-ready tool definition.
 */
export function createCameraTool(options: CameraToolOptions): ToolDefinition {
  const labels = new Map(options.devices.map(device => [String(device.id), device.label]))
  const deviceIds = options.devices.map(device => String(device.id))
  return defineTool({
    name: CAMERA_TOOL_NAME,
    description: 'Read what the home cameras recorded: doorbell presses and motion events with the time, the camera, '
      + 'what the vision check saw (people, vehicles, packages, animals), a one-line description, and whether the user '
      + `was notified. Times are local to ${options.timezone}. Use it for questions such as what happened at the door today. `
      + 'It cannot show live video, take new pictures, or say who someone is.',
    parameters: {
      camera: { type: 'string', enum: deviceIds, description: 'Only this camera; omit for every camera.' },
      hours: { type: 'integer', description: `How many hours back to read, from 1 through ${String(options.maxHours)}; defaults to 24.` },
      limit: { type: 'integer', description: `Most events to list, from 1 through ${String(options.maxEvents)}; defaults to 20.` },
      notified_only: { type: 'boolean', description: 'List only events the user was notified about.' },
    },
    output: TEXT_TOOL_OUTPUT,
    execute: (args) => {
      const hours = args.hours ?? 24
      if (hours < 1 || hours > options.maxHours) {
        throw new Error(`camera: hours must be an integer from 1 through ${String(options.maxHours)}`)
      }
      const limit = args.limit ?? 20
      if (limit < 1 || limit > options.maxEvents) {
        throw new Error(`camera: limit must be an integer from 1 through ${String(options.maxEvents)}`)
      }
      const now = options.now()
      const since = now - hours * 3_600_000
      const matching = [...options.table.entries()].map(([, record]) => record)
        .filter(record => record.occurredAt >= since
          && (args.camera === undefined || record.deviceId === args.camera)
          && (args.notified_only !== true || notified(record)))
        .sort((left, right) => right.occurredAt - left.occurredAt)
      return Promise.resolve({ text: JSON.stringify({
        timezone: options.timezone,
        from: localDateTime(since, options.timezone),
        to: localDateTime(now, options.timezone),
        total: matching.length,
        events: matching.slice(0, limit).map(record => modelEvent(record, labels, options.timezone)),
      }) })
    },
    presentCall: args => ({ card: 'generic', title: 'Camera events', kind: 'read', rawInput: JSON.stringify(args) }),
  })
}
