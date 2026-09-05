/**
 * Global cron scheduler: configured jobs fire on their own schedule in the host process, each one
 * starting an unattended Agent Session with its own prompt, presets, and workspace. Delivery of what
 * the run produced is the agent's job through whatever tools its preset has.
 * @module @deepseek-ai/dsh-cron
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { errorChain } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { createJobRunner } from './launch.ts'
import type { JobRunner } from './launch.ts'
import { assertSchedule, cronerScheduler } from './schedule.ts'
import type { Scheduler } from './schedule.ts'
import type { CronJobSpec } from './types.ts'
export * from './launch.ts'
export * from './schedule.ts'
export type * from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'cron'

/** Services a scheduled run is mounted through. */
export const inject = [
  'agentDefaultModel',
  'agentPresets',
  'agents',
  'permissionPresets',
  'sessionTitle',
  'workspaceRegistry',
]

/** Longest wait for one run's turn before it is reported as timed out. */
export const DEFAULT_CRON_TURN_TIMEOUT_MS = 600_000

/** Runs whose Sessions stay mounted per job list before the oldest is released. */
export const DEFAULT_CRON_MAX_LIVE_RUNS = 20

export const Config: z<{ jobs: CronJobSpec[]; turnTimeoutMs: number; maxLiveRuns: number }> = z.object({
  jobs: z.array(z.object({
    name: z.string().required(),
    expression: z.string().required(),
    timezone: z.string().required(),
    prompt: z.string().required(),
    agentPreset: z.string().required(),
    permissionPreset: z.string().required(),
    workspacePath: z.string().required(),
    title: z.string(),
  })).default([]),
  turnTimeoutMs: z.number().min(1_000).default(DEFAULT_CRON_TURN_TIMEOUT_MS),
  maxLiveRuns: z.number().min(1).default(DEFAULT_CRON_MAX_LIVE_RUNS),
})

/** Complete configuration after schemastery applies every field default. */
export interface ResolvedConfig {
  /** Jobs to mount at load; an empty list mounts nothing. */
  readonly jobs: CronJobSpec[]
  /** Longest wait for one run's answer, in milliseconds. */
  readonly turnTimeoutMs: number
  /** Most recent runs kept mounted per process before the oldest are released. */
  readonly maxLiveRuns: number
}

/**
 * Reject a job list that could not run: duplicate names, an unparseable expression or timezone, a
 * relative workspace, or a non-positive bound.
 * @param config - complete plugin configuration.
 * @throws when any job would fail at its first fire.
 */
export function assertConfig(config: ResolvedConfig): void {
  const seen = new Set<string>()
  for (const job of config.jobs) {
    if (seen.has(job.name)) {
      throw new Error(`dsh-cron: job names must be unique, "${job.name}" appears twice`)
    }
    seen.add(job.name)
    try {
      assertSchedule(job.expression, job.timezone)
    } catch (error: unknown) {
      throw new Error(`dsh-cron: job "${job.name}" has an unusable schedule: ${errorChain(error)}`)
    }
    if (!isAbsolute(job.workspacePath)) {
      throw new Error(`dsh-cron: job "${job.name}" needs an absolute workspacePath, got "${job.workspacePath}"`)
    }
  }
  for (const [field, value] of Object.entries({ turnTimeoutMs: config.turnTimeoutMs, maxLiveRuns: config.maxLiveRuns })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`dsh-cron: ${field} must be a positive safe integer`)
    }
  }
}

/** What mounting one job list returns: the runner plus the handles that stop the timers. */
export interface MountedJobs {
  readonly runner: JobRunner
  /** Stop every timer and dispose every Session the runs opened. */
  dispose(): Promise<void>
}

/**
 * Schedule every configured job and start its runs.
 *
 * A job that is still running when its expression matches again is skipped with a warning rather than
 * started twice, so a slow run cannot stack up sessions.
 *
 * @param ctx - registrant context carrying Session-creating services.
 * @param config - complete plugin configuration.
 * @param scheduler - scheduling seam, defaulting to croner.
 * @returns the runner and the disposer that stops every timer it started.
 */
export function mountJobs(ctx: Context, config: ResolvedConfig, scheduler: Scheduler = cronerScheduler): MountedJobs {
  const controller = new AbortController()
  const runner = createJobRunner({
    ctx,
    signal: controller.signal,
    turnTimeoutMs: config.turnTimeoutMs,
  })
  const inFlight = new Map<string, Promise<unknown>>()
  const timers: { stop(): void }[] = []

  for (const job of config.jobs) {
    const scheduled = scheduler({ expression: job.expression, timezone: job.timezone }, (firedAt: number) => {
      const running = inFlight.get(job.name)
      if (running !== undefined) {
        ctx.logger.warn(`dsh-cron: job "${job.name}" is still running; this fire is skipped`)
        return
      }
      const run = runner.run(job, firedAt)
        .catch((error: unknown) => {
          ctx.logger.error(`dsh-cron: job "${job.name}" run reported a failure: ${errorChain(error)}`)
        })
        .finally(() => {
          inFlight.delete(job.name)
          void runner.trim(config.maxLiveRuns)
        })
      inFlight.set(job.name, run)
    })
    timers.push(scheduled)
    const next = scheduled.nextRunAt()
    ctx.logger.info(`dsh-cron: scheduled "${job.name}" (${job.expression} ${job.timezone})`
      + (next === undefined ? '' : `, next run ${new Date(next).toISOString()}`))
  }

  return {
    runner,
    async dispose(): Promise<void> {
      controller.abort(new Error('dsh-cron disposed'))
      for (const timer of timers.splice(0)) timer.stop()
      inFlight.clear()
      await runner.dispose()
    },
  }
}

/**
 * Mount the scheduler: validate the job list, schedule every job, and stop all of them when the
 * fiber goes away.
 * @param ctx - registrant context carrying Session-creating services.
 * @param config - deployment's job list and bounds.
 */
export function apply(ctx: Context, resolved: ResolvedConfig): void {
  assertConfig(resolved)
  if (resolved.jobs.length === 0) {
    ctx.logger.info('dsh-cron: mounted with no jobs')
    return
  }
  const mounted = mountJobs(ctx, resolved)
  ctx.effect(() => async () => {
    await mounted.dispose()
  }, 'dsh-cron scheduled jobs')
}
