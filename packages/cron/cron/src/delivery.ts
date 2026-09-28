/**
 * Transport-neutral delivery text for one finished run, shared by every delivery owner that
 * listens to `cron/run-finished`, and validation of a job's delivery target.
 * @module @deepseek-ai/dsh-cron/delivery
 */

import { DELIVERY_TARGET_FORMS, parseDeliveryTarget } from '@deepseek-ai/dsh-delivery-target'
import type { CronRunOutcome, CronRunResult } from './types.ts'

/** What one settled scheduled run announces on the `cron/run-finished` event. */
export interface FinishedCronRun extends Pick<CronRunResult, 'outcome' | 'text' | 'failure'> {
  readonly reportOutcome: boolean
  readonly jobName?: string
  readonly sessionId?: string
  readonly nextFireAt?: string
}

/** Words delivered when a scheduled run has no text of its own and the operator wants to know. */
const CRON_OUTCOME_LINES: Record<CronRunOutcome, string | undefined> = {
  answered: undefined,
  'no-text-answer': 'The scheduled run finished without a text answer.',
  'timed-out': 'The scheduled run timed out.',
  interrupted: 'The scheduled run was interrupted.',
  failed: 'The scheduled run failed.',
  skipped: undefined,
}

/**
 * Select the final text or requested outcome notice for one finished cron run.
 * @param run - Finished result and outcome-reporting preference.
 * @returns delivery text, or undefined when the run has nothing to announce.
 */
export function cronDeliveryContent(run: FinishedCronRun): string | undefined {
  if (run.outcome === 'answered' && run.text !== '') return run.text
  if (!run.reportOutcome) return undefined
  if (run.outcome === 'failed') {
    const code = run.failure?.code
    const label = run.jobName === undefined ? 'The scheduled run' : `The scheduled run "${run.jobName}"`
    const safeCode = code !== undefined && /^[A-Z][A-Z0-9_-]{0,63}$/u.test(code) ? code : 'FAILED'
    return `${label} failed (${safeCode}). Session: ${run.sessionId || 'unavailable'}. Next fire: ${run.nextFireAt ?? 'none'}.`
  }
  if (run.outcome === 'skipped') {
    const label = run.jobName === undefined ? 'The scheduled run' : `The scheduled run "${run.jobName}"`
    const reason = run.failure?.code === 'PREVIOUS_OUTCOME_PENDING'
      ? 'its previous outcome is awaiting delivery'
      : 'its previous run was still in progress'
    return `${label} was skipped because ${reason}. Next fire: ${run.nextFireAt ?? 'none'}.`
  }
  return CRON_OUTCOME_LINES[run.outcome]
}

/**
 * Reject a delivery target no delivery owner can claim. Stored jobs are not re-validated, so a
 * target saved before validation existed keeps its earlier behavior.
 * @param value - configured or tool-supplied target.
 * @param field - field name for the error, such as `deliver_channel`.
 * @throws Error naming the field and every accepted form.
 */
export function assertCronDeliveryTarget(value: string, field: string): void {
  if (parseDeliveryTarget(value) === undefined) throw new Error(`${field} must be ${DELIVERY_TARGET_FORMS}`)
}
