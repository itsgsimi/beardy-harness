/**
 * Notification policy: which questions one event's classification asks and which reasons its answers
 * carry. Every rule is evaluated in code from the event, the answers, and the device's baseline
 * event; a true answer always cites evidence frames, and the model's own confidence is never read.
 * A person notifies at any hour only on a `personDevices` camera, and a vehicle notifies by what it
 * does, never by being visible.
 * @module @deepseek-ai/dsh-camera-watch/policy
 */

import type { CameraEventKind, CameraQuestion, CameraVerdict } from '@deepseek-ai/dsh-camera'
import type { ResolvedPolicy } from './config.ts'
import type { NoticeReason, VehicleMovement, VerdictStatus } from './types.ts'

/** The event facts the policy reads. */
export interface PolicyEvent {
  readonly kind: CameraEventKind
  readonly deviceId: string
  readonly occurredAt: number
  /** Frame offsets in capture order, in milliseconds after the event. */
  readonly offsetsMs: readonly number[]
}

/** Which classification is being asked about. */
export interface QuestionScope {
  readonly kind: CameraEventKind
  readonly deviceId: string
  /** Frames the model receives. */
  readonly frameCount: number
  /** The check sees only the event's first frame, before the rest are captured. */
  readonly firstFrame?: boolean
}

/**
 * The questions one classification asks, in canonical order: only those an enabled rule for the
 * device reads. `person_on_property` serves the night, `personDevices`, and lingering rules;
 * `person_at_door` joins it on a `doorDevices` camera and for any doorbell press; `person_staying`
 * serves the lingering rule and needs two frames; `package_being_delivered` serves the package rule,
 * and `package_present` joins it when a baseline can show the package is new; the vehicle questions
 * serve `vehicleDevices` for each movement in `vehicleActivities`. A first-frame check never asks
 * `person_staying`, `package_present`, or `vehicle_leaving`.
 * @param policy - resolved rules.
 * @param scope - event kind, device, frame count, and whether it is a first-frame check.
 * @returns questions to ask.
 */
export function askedQuestions(policy: ResolvedPolicy, scope: QuestionScope): CameraQuestion[] {
  const full = scope.firstFrame !== true
  const staying = full && scope.frameCount >= 2
  const person = policy.nightPerson || policy.personDevices.includes(scope.deviceId) || staying
  const door = scope.kind === 'ding' || policy.doorDevices.includes(scope.deviceId)
  const vehicle = policy.vehicleDevices.includes(scope.deviceId)
  const asked: Record<CameraQuestion, boolean> = {
    person_on_property: person,
    person_at_door: person && door,
    person_staying: staying,
    package_present: policy.packageDelivered && full && policy.arrivalBaselineMs > 0,
    package_being_delivered: policy.packageDelivered,
    vehicle_arriving: vehicle && policy.vehicleActivities.includes('arriving'),
    vehicle_leaving: vehicle && full && policy.vehicleActivities.includes('leaving'),
  }
  return (Object.keys(asked) as CameraQuestion[]).filter(question => asked[question])
}

/**
 * Whether a verdict answered one question true; a true answer always has evidence frames.
 * @param verdict - the event's verdict.
 * @param question - the question.
 * @returns true for a true answer.
 */
export function answeredTrue(verdict: CameraVerdict, question: CameraQuestion): boolean {
  return verdict.answers[question]?.answer === true
}

/**
 * Evidence frames of the true person answers, ascending.
 * @param verdict - the event's verdict.
 * @returns frame indices showing a person on the property, at the door, or staying.
 */
export function personFrames(verdict: CameraVerdict): number[] {
  const frames = new Set<number>()
  for (const question of ['person_on_property', 'person_at_door', 'person_staying'] as const) {
    for (const frame of verdict.answers[question]?.frames ?? []) frames.add(frame)
  }
  return [...frames].sort((left, right) => left - right)
}

/**
 * Compare the vehicle counts of an event and the device's baseline event: more vehicles read as an
 * arrival, fewer as a departure. A label without a count counts as zero vehicles.
 * @param current - the event's verdict.
 * @param baseline - the baseline event's verdict.
 * @returns the movement, or undefined when the counts are equal.
 */
export function vehicleChange(current: Pick<CameraVerdict, 'counts'>, baseline: Pick<CameraVerdict, 'counts'>): VehicleMovement | undefined {
  const now = current.counts.vehicle ?? 0
  const before = baseline.counts.vehicle ?? 0
  if (now === before) return undefined
  return now > before ? 'arriving' : 'leaving'
}

/** What the device's baseline event adds to one event's rules. */
export interface BaselineFacts {
  /** Vehicle count movement against the baseline, on a `vehicleDevices` camera. */
  readonly vehicleChange?: VehicleMovement | undefined
  /** The baseline answered `package_present` false. */
  readonly packageAbsent?: boolean | undefined
}

/** Reasons for one event, and the vehicle movement behind a `vehicle` reason. */
export interface NoticeDecision {
  readonly reasons: NoticeReason[]
  /** Present exactly when `reasons` includes `vehicle`. */
  readonly vehicle?: VehicleMovement
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
 * without a verdict; every other rule needs a `parsed` or `partial` verdict. A person is seen when
 * `person_on_property` or `person_at_door` is true. `package` needs `package_being_delivered`, or
 * `package_present` with a baseline that answered it false. `vehicle` takes the first of the count
 * movement against the baseline, a true `vehicle_arriving`, and a true `vehicle_leaving` that
 * `vehicleActivities` lists. `lingering` needs a true `person_staying` and person evidence frames
 * spanning at least `lingerMs`.
 * @param event - kind, device, time, and frame offsets.
 * @param verdict - classification, when one was read.
 * @param status - how complete the reading was.
 * @param policy - resolved rules.
 * @param timezone - zone for the night window.
 * @param baseline - what the device's baseline event adds; empty for a first-frame check.
 * @returns reasons, empty to stay quiet, and the notifying vehicle movement.
 */
export function noticeReasons(
  event: PolicyEvent, verdict: CameraVerdict | undefined, status: VerdictStatus, policy: ResolvedPolicy, timezone: string,
  baseline: BaselineFacts = {},
): NoticeDecision {
  const reasons: NoticeReason[] = []
  if (event.kind === 'ding' && policy.ding) reasons.push('ding')
  if (verdict === undefined || (status !== 'parsed' && status !== 'partial')) return { reasons }
  if (policy.packageDelivered && (answeredTrue(verdict, 'package_being_delivered')
    || (answeredTrue(verdict, 'package_present') && baseline.packageAbsent === true))) reasons.push('package')
  const person = answeredTrue(verdict, 'person_on_property') || answeredTrue(verdict, 'person_at_door')
  if (policy.nightPerson && person
    && insideWindow(localMinute(event.occurredAt, timezone), policy.nightStartMinute, policy.nightEndMinute)) {
    reasons.push('night-person')
  }
  if (person && policy.personDevices.includes(event.deviceId)) reasons.push('person')
  let vehicle: VehicleMovement | undefined
  if (policy.vehicleDevices.includes(event.deviceId)) {
    const movements = [
      baseline.vehicleChange,
      answeredTrue(verdict, 'vehicle_arriving') ? 'arriving' as const : undefined,
      answeredTrue(verdict, 'vehicle_leaving') ? 'leaving' as const : undefined,
    ]
    vehicle = movements.find(movement => movement !== undefined && policy.vehicleActivities.includes(movement))
    if (vehicle !== undefined) reasons.push('vehicle')
  }
  if (answeredTrue(verdict, 'person_staying') && lingeringMs(event, verdict) >= policy.lingerMs) reasons.push('lingering')
  return vehicle === undefined ? { reasons } : { reasons, vehicle }
}

/**
 * Time between the first and last person evidence frame, from recorded frame offsets.
 * @param event - frame offsets.
 * @param verdict - person answers and their evidence frames.
 * @returns milliseconds a person stayed in view; zero with fewer than two person frames.
 */
export function lingeringMs(event: PolicyEvent, verdict: CameraVerdict): number {
  const offsets = personFrames(verdict).map(index => event.offsetsMs[index]).filter((value): value is number => value !== undefined)
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
