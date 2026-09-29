/** Local time formatting and notice text for one camera event. @module @deepseek-ai/dsh-camera-watch/notice */

import type { CameraCaptureFailure, CameraVerdict } from '@deepseek-ai/dsh-camera'
import type { NoticeReason, VehicleMovement, VerdictStatus } from './types.ts'

/**
 * Format an instant as local `YYYY-MM-DD HH:MM:SS` in one IANA time zone.
 * @param epochMs - instant to format.
 * @param timezone - validated IANA time zone.
 * @returns local date and time.
 */
export function localDateTime(epochMs: number, timezone: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date(epochMs))
}

/** Everything one notice states. */
export interface NoticeFacts {
  readonly deviceLabel: string
  readonly occurredAt: number
  readonly timezone: string
  readonly reasons: readonly NoticeReason[]
  readonly status: VerdictStatus
  readonly verdict?: CameraVerdict | undefined
  readonly text?: string | undefined
  readonly failure?: string | undefined
  readonly captureFailure?: CameraCaptureFailure | undefined
  /** Seconds a person stayed in view, for the lingering reason. */
  readonly lingerSeconds: number
  /** The vehicle movement behind the `vehicle` reason; it names the vehicle headline. */
  readonly vehicle?: VehicleMovement | undefined
  /**
   * `first-frame` for the early motion notice from the first frame alone, `update` for a classified
   * notice that follows a delivered early motion notice; absent for a standalone notice.
   */
  readonly stage?: 'first-frame' | 'update' | undefined
}

/** Last line of the early motion notice. */
export const FIRST_FRAME_LINE = 'From the first picture; an update follows only if the rest shows more.'

const HEADLINES: Readonly<Record<NoticeReason, (facts: NoticeFacts) => string>> = {
  ding: () => 'Doorbell rang',
  package: () => 'Package delivered',
  'night-person': () => 'Person at night',
  person: facts => `Person at ${facts.deviceLabel}`,
  vehicle: facts => `Vehicle ${facts.vehicle ?? 'moving'}`,
  lingering: facts => `Someone lingering (${String(facts.lingerSeconds)} s)`,
}

function heading(deviceLabel: string, occurredAt: number, timezone: string, update = false): string {
  return `**${deviceLabel}** · ${localDateTime(occurredAt, timezone).slice(11, 16)}${update ? ' (update)' : ''}`
}

/** Everything the immediate doorbell notice states. */
export interface DingNoticeFacts {
  readonly deviceLabel: string
  readonly occurredAt: number
  readonly timezone: string
}

/**
 * Compose the immediate doorbell notice posted before classification: device, local time, and
 * that someone rang.
 * @param facts - device label, event time, and zone.
 * @returns notice text.
 */
export function renderDingNotice(facts: DingNoticeFacts): string {
  return `${heading(facts.deviceLabel, facts.occurredAt, facts.timezone)}: Someone rang the doorbell`
}

function missingDescription(facts: NoticeFacts): string {
  if (facts.failure === 'NO_FRAMES') return 'No picture could be captured.'
  if (facts.failure === 'QUEUE_FULL') return 'Not checked: earlier events were still being checked.'
  return `The vision check did not answer (${facts.failure ?? 'unknown'}).`
}

/**
 * Reasons that get their own headline: `night-person` already states that a person was seen, so it
 * absorbs `person` when both apply. History and the `camera` tool keep both reasons.
 * @param reasons - reasons in canonical order.
 * @returns reasons to render, in the same order.
 */
export function headlineReasons(reasons: readonly NoticeReason[]): NoticeReason[] {
  return reasons.filter(reason => reason !== 'person' || !reasons.includes('night-person'))
}

/**
 * Compose the notice text: device, local time (marked `(update)` for an update), and reasons; the
 * description or why it is missing; the counted objects; and, for an early motion
 * notice, {@link FIRST_FRAME_LINE}. The result stays under 2000 characters.
 * @param facts - event, reasons, and classification.
 * @returns notice text.
 */
export function renderNotice(facts: NoticeFacts): string {
  const headlines = headlineReasons(facts.reasons).map(reason => HEADLINES[reason](facts))
  const lines = [`${heading(facts.deviceLabel, facts.occurredAt, facts.timezone, facts.stage === 'update')}: ${headlines.join('; ')}`]
  if (facts.verdict !== undefined) {
    lines.push(facts.verdict.description)
    const counts = Object.entries(facts.verdict.counts).filter(([, count]) => count > 0).map(([label, count]) => `${label} ${String(count)}`)
    lines.push(counts.length === 0 ? 'Nothing counted' : `Seen: ${counts.join(', ')}`)
  } else if (facts.status === 'unparsed') {
    lines.push(facts.text ?? '')
  } else {
    lines.push(missingDescription(facts))
  }
  if (facts.captureFailure !== undefined) lines.push(`Fewer pictures than planned (${facts.captureFailure}).`)
  if (facts.stage === 'first-frame') lines.push(FIRST_FRAME_LINE)
  return lines.filter(line => line !== '').join('\n')
}

/** Everything a classification failure notice states. */
export interface FailureNoticeFacts {
  /** Stable failure code, such as `MODEL_UNAVAILABLE`. */
  readonly code: string
  /** Bounded one-line cause. */
  readonly cause: string
  /** Whether doorbell presses still notify without a verdict, which `policy.ding` decides. */
  readonly dingNotifies: boolean
  /** A first-frame check on its own route is failing; full classifications are unaffected. */
  readonly firstFrame?: boolean
}

/**
 * Compose the notice that classification is failing: the code and cause, that motion alerts no
 * longer notify, and, while `policy.ding` is on, that doorbell presses still do. For first-frame
 * checks on their own route it states instead that motion alerts wait for the full check.
 * @param facts - failure code, cause, doorbell rule, and stage.
 * @returns notice text.
 */
export function renderFailureNotice(facts: FailureNoticeFacts): string {
  if (facts.firstFrame === true) {
    return `⚠️ Camera first-frame checks are failing (${facts.code}: ${facts.cause}). Motion alerts wait for the full check.`
  }
  const effect = facts.dingNotifies ? 'Motion alerts are paused; doorbell presses still post.' : 'Motion alerts are paused.'
  return `⚠️ Camera classification is failing (${facts.code}: ${facts.cause}). ${effect}`
}

/** The line posted after the first answered classification that follows a failure notice. */
export const RECOVERY_NOTICE_TEXT = 'Camera classification recovered.'

/** The line posted after the first answered first-frame check that follows a first-frame failure notice. */
export const FIRST_FRAME_RECOVERY_NOTICE_TEXT = 'Camera first-frame checks recovered.'
