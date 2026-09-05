/**
 * Scheduling seam over croner: one cron expression plus a timezone becomes a live timer that calls
 * back on every match.
 * @module @deepseek-ai/dsh-cron/schedule
 */

import { Cron, CronPattern } from 'croner'

/** A scheduled job the plugin can stop and ask about. */
export interface ScheduledJob {
  /** Stop firing; safe to call more than once. */
  stop(): void
  /** Next match after now in epoch milliseconds, or undefined once stopped. */
  nextRunAt(): number | undefined
}

/** Creates one timer for one job. Tests substitute a fake to fire on demand. */
export type Scheduler = (job: { expression: string; timezone: string }, onTick: (firedAt: number) => void) => ScheduledJob

/** Validate a pattern and timezone without starting a timer. */
export function assertSchedule(expression: string, timezone: string): void {
  new CronPattern(expression, timezone)
}

/** croner-backed scheduler: protected against overlap, evaluated in the job's own timezone. */
export const cronerScheduler: Scheduler = (job, onTick) => {
  const cron = new Cron(job.expression, { timezone: job.timezone, protect: true }, () => {
    onTick(Date.now())
  })
  return {
    stop: () => { cron.stop() },
    nextRunAt: () => cron.nextRun()?.getTime(),
  }
}
