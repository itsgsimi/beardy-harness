/** Local time formatting and notice text for one camera event. @module @deepseek-ai/dsh-camera-watch/notice */

import type { CameraCaptureFailure, CameraVerdict } from '@deepseek-ai/dsh-camera'
import type { NoticeReason, VerdictStatus } from './types.ts'

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
}

const HEADLINES: Readonly<Record<NoticeReason, (facts: NoticeFacts) => string>> = {
  ding: () => 'Doorbell rang',
  package: () => 'Package delivered',
  'night-person': () => 'Person at night',
  // The vehicle reason exists only for a verdict whose vehicle activity matched the policy.
  vehicle: facts => `Vehicle ${facts.verdict?.vehicleActivity ?? 'seen'}`,
  lingering: facts => `Someone lingering (${String(facts.lingerSeconds)} s)`,
}

function heading(deviceLabel: string, occurredAt: number, timezone: string): string {
  return `**${deviceLabel}** · ${localDateTime(occurredAt, timezone).slice(11, 16)}`
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
 * Compose the notice text: device, local time, and reasons; the description or why it is missing;
 * and the counted objects with confidence. The result stays under 2000 characters.
 * @param facts - event, reasons, and classification.
 * @returns notice text.
 */
export function renderNotice(facts: NoticeFacts): string {
  const lines = [`${heading(facts.deviceLabel, facts.occurredAt, facts.timezone)}: ${facts.reasons.map(reason => HEADLINES[reason](facts)).join('; ')}`]
  if (facts.verdict !== undefined) {
    lines.push(facts.verdict.description)
    const counts = Object.entries(facts.verdict.counts).filter(([, count]) => count > 0).map(([label, count]) => `${label} ${String(count)}`)
    lines.push(`${counts.length === 0 ? 'Nothing counted' : `Seen: ${counts.join(', ')}`} · confidence ${String(Math.round(facts.verdict.confidence * 100))}%`)
  } else if (facts.status === 'unparsed') {
    lines.push(facts.text ?? '')
  } else {
    lines.push(missingDescription(facts))
  }
  if (facts.captureFailure !== undefined) lines.push(`Fewer pictures than planned (${facts.captureFailure}).`)
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
}

/**
 * Compose the notice that classification is failing: the code and cause, that motion alerts no
 * longer notify, and, while `policy.ding` is on, that doorbell presses still do.
 * @param facts - failure code, cause, and doorbell rule.
 * @returns notice text.
 */
export function renderFailureNotice(facts: FailureNoticeFacts): string {
  const effect = facts.dingNotifies ? 'Motion alerts are paused; doorbell presses still post.' : 'Motion alerts are paused.'
  return `⚠️ Camera classification is failing (${facts.code}: ${facts.cause}). ${effect}`
}

/** The line posted after the first answered classification that follows a failure notice. */
export const RECOVERY_NOTICE_TEXT = 'Camera classification recovered.'
