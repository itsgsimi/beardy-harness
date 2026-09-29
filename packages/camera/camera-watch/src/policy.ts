/**
 * Notification policy: which reasons one classified event carries. Every rule is evaluated in code
 * from the event and the verdict; the model's own `lingering` activity never triggers a notice, a
 * vehicle notifies by what it does, never by being visible, and a person notifies at any hour only on
 * a `personDevices` camera. What a vehicle does is the model's `vehicleActivity` unless the vehicle
 * count changed against the device's previous event, which then decides.
 * @module @deepseek-ai/dsh-camera-watch/policy
 */

import type { CameraEventKind, CameraVerdict } from '@deepseek-ai/dsh-camera'
import type { ResolvedPolicy } from './config.ts'
import type { NoticeReason, VerdictStatus } from './types.ts'

/** The event facts the policy reads. */
export interface PolicyEvent {
  readonly kind: CameraEventKind
  readonly deviceId: string
  readonly occurredAt: number
  /** Frame offsets in capture order, in milliseconds after the event. */
  readonly offsetsMs: readonly number[]
}

/** Vehicle movement read from a vehicle count that differs from the device's previous event. */
export type VehicleChange = 'arriving' | 'leaving'

/**
 * Compare the vehicle counts of an event and the device's previous event: more vehicles read as an
 * arrival, fewer as a departure. A label without a count counts as zero vehicles.
 * @param current - the event's verdict.
 * @param baseline - the previous event's verdict.
 * @returns the movement, or undefined when the counts are equal.
 */
export function vehicleChange(current: CameraVerdict, baseline: CameraVerdict): VehicleChange | undefined {
  const now = current.counts.vehicle ?? 0
  const before = baseline.counts.vehicle ?? 0
  if (now === before) return undefined
  return now > before ? 'arriving' : 'leaving'
}

/**
 * Minutes after local midnight in one IANA time zone.
 * @param epochMs - instant to convert.
 * @param timezone - validated IANA time zone.
 * @returns minute of the local day, 0 through 1439.
 */
export function localMinute(epochMs: number, timezone: string): number {
  const text = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(epochMs))
  return Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5))
}

/**
 * Whether a local minute lies inside a window that may cross midnight; the start is inclusive and
 * the end exclusive.
 * @param minute - local minute of day.
 * @param start - window start minute.
 * @param end - window end minute, different from `start`.
 * @returns true inside the window.
 */
export function insideWindow(minute: number, start: number, end: number): boolean {
  return start < end ? minute >= start && minute < end : minute >= start || minute < end
}

/**
 * Decide the notification reasons for one event, in canonical order. A doorbell press notifies
 * without a verdict; every other rule needs a `parsed` or `partial` verdict at or above the
 * confidence floor.
 * @param event - kind, device, time, and frame offsets.
 * @param verdict - classification, when one was read.
 * @param status - how complete the reading was.
 * @param policy - resolved rules.
 * @param timezone - zone for the night window.
 * @param change - vehicle count movement against the device's previous event; it replaces the model's vehicle activity.
 * @returns reasons; empty means stay quiet.
 */
export function noticeReasons(
  event: PolicyEvent, verdict: CameraVerdict | undefined, status: VerdictStatus, policy: ResolvedPolicy, timezone: string,
  change?: VehicleChange,
): NoticeReason[] {
  const reasons: NoticeReason[] = []
  if (event.kind === 'ding' && policy.ding) reasons.push('ding')
  if (verdict === undefined || (status !== 'parsed' && status !== 'partial') || verdict.confidence < policy.minConfidence) return reasons
  if (policy.packageDelivered && verdict.labels.includes('package') && verdict.activity === 'delivering') reasons.push('package')
  const person = verdict.labels.includes('person')
  if (policy.nightPerson && person
    && insideWindow(localMinute(event.occurredAt, timezone), policy.nightStartMinute, policy.nightEndMinute)) {
    reasons.push('night-person')
  }
  if (person && policy.personDevices.includes(event.deviceId)) reasons.push('person')
  if (policy.vehicleDevices.includes(event.deviceId)
    && policy.vehicleActivities.some(activity => activity === (change ?? verdict.vehicleActivity))) {
    reasons.push('vehicle')
  }
  if (lingeringMs(event, verdict) >= policy.lingerMs) reasons.push('lingering')
  return reasons
}

/**
 * Time between the first and last frame showing a person, from recorded frame offsets.
 * @param event - frame offsets.
 * @param verdict - person frame indices.
 * @returns milliseconds a person stayed in view; zero with fewer than two person frames.
 */
export function lingeringMs(event: PolicyEvent, verdict: CameraVerdict): number {
  const offsets = verdict.personFrames.map(index => event.offsetsMs[index]).filter((value): value is number => value !== undefined)
  return offsets.length < 2 ? 0 : Math.max(...offsets) - Math.min(...offsets)
}

/** What an early motion notice stated. */
export interface EarlyStatement {
  readonly reasons: readonly NoticeReason[]
  readonly verdict: CameraVerdict
}

/**
 * Whether the full classification adds to a delivered early motion notice: it found a reason the
 * early notice did not state, or it counts more of any label than the first frame did. A different
 * description alone adds nothing, since two model answers rarely word the same scene alike.
 * @param early - reasons and verdict of the early notice.
 * @param reasons - reasons of the full classification.
 * @param verdict - verdict of the full classification, when one was read.
 * @returns true when an update notice should follow.
 */
export function addsToEarlyNotice(early: EarlyStatement, reasons: readonly NoticeReason[], verdict: CameraVerdict | undefined): boolean {
  if (reasons.some(reason => !early.reasons.includes(reason))) return true
  if (verdict === undefined || reasons.length === 0) return false
  return Object.entries(verdict.counts).some(([label, count]) => count > (early.verdict.counts[label as keyof CameraVerdict['counts']] ?? 0))
}
