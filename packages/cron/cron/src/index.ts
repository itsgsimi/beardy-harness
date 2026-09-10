/**
 * Global cron scheduler: configured jobs and durably stored runtime-created jobs fire on their own
 * schedule in the host process, each one starting an unattended Agent Session with its own prompt,
 * presets, and workspace. The `cron_manage` tool and the `/cron` command manage stored jobs while
 * the process runs; finished runs emit `cron/run-finished` for whichever listener owns delivery.
 * @module @deepseek-ai/dsh-cron
 */

import { isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { errorChain } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-user-approval'
import { cronDomainSpec } from './domain.ts'
import { createJobRegistry } from './registry.ts'
import { createJobRunner } from './launch.ts'
import type { JobRunner } from './launch.ts'
import { assertSchedule, cronerScheduler } from './schedule.ts'
import type { Scheduler } from './schedule.ts'
import { createCronManageTool } from './tool.ts'
import { registerCronCommand } from './command.ts'
import type { ConfiguredCronJob, CronRunFinished, CronRunResult, ScheduledJobSpec } from './types.ts'
export * from './domain.ts'
export * from './launch.ts'
export * from './registry.ts'
export * from './schedule.ts'
export * from './tool.ts'
export * from './command.ts'
export type * from './types.ts'

/** Cordis plugin name used for loader diagnostics. */
export const name = 'cron'

/** Services a scheduled run is mounted through, plus the surfaces that manage jobs. */
export const inject = [
  'agentDefaultModel',
  'agentPresets',
  'agents',
  'commands',
  'permissionPresets',
  'sessionTitle',
  'storageDomain',
  'tools',
  'workspaceRegistry',
]

/** Longest wait for one run's turn before it is reported as timed out. */
export const DEFAULT_CRON_TURN_TIMEOUT_MS = 600_000

/** Runs whose Sessions stay mounted per job list before the oldest is released. */
export const DEFAULT_CRON_MAX_LIVE_RUNS = 20

/** Shortest gap two consecutive fires of a stored schedule may have, in milliseconds. */
export const DEFAULT_CRON_MIN_INTERVAL_MS = 300_000

/** Most jobs the durable store may hold. */
export const DEFAULT_CRON_MAX_STORED_JOBS = 20

/** Character cap for one job's continuity notes. */
export const DEFAULT_CRON_NOTES_MAX_CHARS = 8_000

/** Run outcomes retained per job. */
export const DEFAULT_CRON_KEEP_RUN_HISTORY = 5

/** Delay before retrying finished output that no delivery listener durably accepted. */
export const DEFAULT_CRON_DELIVERY_RETRY_MS = 30_000

export const Config: z<{
  jobs: ConfiguredCronJob[]
  turnTimeoutMs: number
  maxLiveRuns: number
  allowedAgentPresets: string[]
  allowedPermissionPresets: string[]
  allowedWorkspaceRoots: string[]
  maxStoredJobs: number
  minIntervalMs: number
  notesMaxChars: number
  keepRunHistory: number
  requireApproval: boolean
  deliverOutcomes: boolean
  deliveryRetryMs: number
}> = z.object({
  jobs: z.array(z.object({
    name: z.string().required(),
    expression: z.string().required(),
    timezone: z.string().required(),
    prompt: z.string().required(),
    agentPreset: z.string().required(),
    permissionPreset: z.string().required(),
    workspacePath: z.string().required(),
    title: z.string(),
    deliverChannel: z.string(),
  })).default([]),
  turnTimeoutMs: z.number().min(1_000).default(DEFAULT_CRON_TURN_TIMEOUT_MS),
  maxLiveRuns: z.number().min(1).default(DEFAULT_CRON_MAX_LIVE_RUNS),
  allowedAgentPresets: z.array(z.string()).default([]),
  allowedPermissionPresets: z.array(z.string()).default([]),
  allowedWorkspaceRoots: z.array(z.string()).default([]),
  maxStoredJobs: z.number().min(0).default(DEFAULT_CRON_MAX_STORED_JOBS),
  minIntervalMs: z.number().min(1_000).default(DEFAULT_CRON_MIN_INTERVAL_MS),
  notesMaxChars: z.number().min(1).default(DEFAULT_CRON_NOTES_MAX_CHARS),
  keepRunHistory: z.number().min(0).default(DEFAULT_CRON_KEEP_RUN_HISTORY),
  requireApproval: z.boolean().default(true),
  deliverOutcomes: z.boolean().default(true),
  deliveryRetryMs: z.number().min(1_000).default(DEFAULT_CRON_DELIVERY_RETRY_MS),
})

/** Complete configuration after schemastery applies every field default. */
export interface ResolvedConfig {
  /** Jobs to mount at load; an empty list still mounts the management surfaces. */
  readonly jobs: ConfiguredCronJob[]
  /** Longest wait for one run's answer, in milliseconds. */
  readonly turnTimeoutMs: number
  /** Most recent runs kept mounted per process before the oldest are released. */
  readonly maxLiveRuns: number
  /** Agent presets a stored job may name; empty refuses every create. */
  readonly allowedAgentPresets: string[]
  /** Permission presets a stored job may name; empty refuses every create. */
  readonly allowedPermissionPresets: string[]
  /** Absolute roots a stored job's workspace path must sit inside. */
  readonly allowedWorkspaceRoots: string[]
  /** Most jobs the durable store may hold. */
  readonly maxStoredJobs: number
  /** Two consecutive fires of a stored schedule must be at least this far apart, in milliseconds. */
  readonly minIntervalMs: number
  /** Character cap for one job's continuity notes. */
  readonly notesMaxChars: number
  /** Run outcomes retained per job. */
  readonly keepRunHistory: number
  /** Create, update, and delete ask the approval service before they land. */
  readonly requireApproval: boolean
  /** Finished runs announce an outcome line when there is no text to deliver. */
  readonly deliverOutcomes: boolean
  /** Delay between retries of finished output awaiting durable delivery acceptance. */
  readonly deliveryRetryMs: number
}

/**
 * Reject a configuration that could not run: duplicate names, an unparseable expression or
 * timezone, a relative workspace or allowed root, or a non-positive bound.
 * @param config - complete plugin configuration.
 * @throws when any job would fail at its first fire or a guardrail cannot be honored.
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
  for (const root of config.allowedWorkspaceRoots) {
    if (!isAbsolute(root)) {
      throw new Error(`dsh-cron: allowedWorkspaceRoots entries must be absolute, got "${root}"`)
    }
  }
  for (const [field, value] of Object.entries({
    turnTimeoutMs: config.turnTimeoutMs,
    maxLiveRuns: config.maxLiveRuns,
    minIntervalMs: config.minIntervalMs,
    notesMaxChars: config.notesMaxChars,
    deliveryRetryMs: config.deliveryRetryMs,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`dsh-cron: ${field} must be a positive safe integer`)
    }
  }
}

/** One job as the scheduler host holds it: what to run plus where finished text is delivered. */
export type HostJob = ScheduledJobSpec

/** What mounting one job list returns: the runner plus the handles that stop the timers. */
export interface MountedJobs {
  readonly runner: JobRunner
  /** Stop every timer and dispose every Session the runs opened. */
  dispose(): Promise<void>
}

/** The live timer set over one job list, re-planable without touching in-flight runs. */
export interface SchedulerHost extends MountedJobs {
  /** Replace the armed job set: stop current timers, start one per job; runs keep going. */
  sync(jobs: readonly HostJob[]): void
  /** Fire an armed job immediately outside its schedule; false when nothing armed carries the name. */
  trigger(name: string): boolean
}

/** Options of one scheduler host. */
export interface SchedulerHostOptions {
  /** Longest wait for one run's answer, in milliseconds. */
  readonly turnTimeoutMs: number
  /** Most recent runs kept mounted before the oldest are released. */
  readonly maxLiveRuns: number
  /** Resolve the current definition and notes when a timer fires; undefined skips a removed job. */
  resolveJob?(name: string): HostJob | undefined
  /** Durably reserve the run before opening its Session. A failure prevents dispatch. */
  onStarting?(job: HostJob, firedAt: number, sessionId: SessionId): Promise<void>
  /** Called once per settled run, after logging and before the fire guard releases. */
  onSettled?(job: HostJob, firedAt: number, result: CronRunResult): void | Promise<void>
}

/**
 * Create the live timer set: one overlap-guarded fire path, re-planable while runs are in flight.
 *
 * A job that is still running when its expression matches again is skipped with a warning rather
 * than started twice, so a slow run cannot stack up sessions.
 *
 * @param ctx - registrant context carrying Session-creating services and the logger.
 * @param options - turn bound, live-run bound, and the settled-run hook.
 * @param scheduler - scheduling seam, defaulting to croner.
 * @returns the host: runner, re-plan, manual trigger, and disposer.
 */
export function createSchedulerHost(
  ctx: Context,
  options: SchedulerHostOptions,
  scheduler: Scheduler = cronerScheduler,
): SchedulerHost {
  const controller = new AbortController()
  const runner = createJobRunner({ ctx, signal: controller.signal, turnTimeoutMs: options.turnTimeoutMs })
  const inFlight = new Map<string, Promise<unknown>>()
  const armed = new Map<string, HostJob>()
  const timers: { stop(): void }[] = []

  function fire(job: HostJob, firedAt: number): boolean {
    if (controller.signal.aborted || armed.get(job.name) !== job) return false
    const running = inFlight.get(job.name)
    if (running !== undefined) {
      ctx.logger.warn(`dsh-cron: job "${job.name}" is still running; this fire is skipped`)
      return false
    }
    const run = Promise.resolve().then(async () => {
      if (controller.signal.aborted) return
      const current = options.resolveJob === undefined ? job : options.resolveJob(job.name)
      if (current === undefined) return
      const sessionId = SessionId(`cron-${job.name}-${randomUUID()}`)
      await options.onStarting?.(current, firedAt, sessionId)
      const result = await runner.run(current, firedAt, sessionId)
      await options.onSettled?.(current, firedAt, result)
      await runner.trim(options.maxLiveRuns)
    })
      .catch((error: unknown) => {
        ctx.logger.error(`dsh-cron: job "${job.name}" run reported a failure: ${errorChain(error)}`)
      })
      .finally(() => {
        inFlight.delete(job.name)
      })
    inFlight.set(job.name, run)
    return true
  }

  return {
    runner,
    sync(jobs: readonly HostJob[]): void {
      if (controller.signal.aborted) return
      for (const timer of timers.splice(0)) timer.stop()
      armed.clear()
      for (const job of jobs) {
        armed.set(job.name, job)
        const scheduled = scheduler({ expression: job.expression, timezone: job.timezone }, (firedAt: number) => {
          fire(job, firedAt)
        })
        timers.push(scheduled)
        const next = scheduled.nextRunAt()
        ctx.logger.info(`dsh-cron: scheduled "${job.name}" (${job.expression} ${job.timezone})`
          + (next === undefined ? '' : `, next run ${new Date(next).toISOString()}`))
      }
    },
    trigger(name: string): boolean {
      const entry = armed.get(name)
      if (entry === undefined) return false
      return fire(entry, Date.now())
    },
    async dispose(): Promise<void> {
      controller.abort(new Error('dsh-cron disposed'))
      for (const timer of timers.splice(0)) timer.stop()
      armed.clear()
      await Promise.all(inFlight.values())
      await runner.dispose()
    },
  }
}

/**
 * Schedule every configured job and start its runs. Retained for configuration-only mounts; the
 * plugin's own {@link apply} goes through {@link createSchedulerHost} plus the job registry.
 *
 * @param ctx - registrant context carrying Session-creating services.
 * @param config - complete plugin configuration.
 * @param scheduler - scheduling seam, defaulting to croner.
 * @returns the runner and the disposer that stops every timer it started.
 */
export function mountJobs(ctx: Context, config: ResolvedConfig, scheduler: Scheduler = cronerScheduler): MountedJobs {
  const host = createSchedulerHost(
    ctx,
    { turnTimeoutMs: config.turnTimeoutMs, maxLiveRuns: config.maxLiveRuns },
    scheduler,
  )
  host.sync(config.jobs.map(job => ({ ...job, notes: '' })))
  return { runner: host.runner, dispose: () => host.dispose() }
}

/**
 * Mount the scheduler: validate the configuration, open the durable job store, schedule every armed
 * job, register `cron_manage` and `/cron`, re-plan when stored jobs change, and stop everything
 * when the fiber goes away. Durable records survive; only timers and live Sessions are released.
 * @param ctx - registrant context carrying Session-creating services, tools, commands, and storage.
 * @param resolved - deployment's job list, bounds, and guardrails.
 * @param scheduler - scheduling seam, defaulting to croner.
 */
export async function apply(
  ctx: Context,
  resolved: ResolvedConfig,
  scheduler: Scheduler = cronerScheduler,
): Promise<void> {
  assertConfig(resolved)
  const configDelivery = new Map<string, string>()
  for (const job of resolved.jobs) {
    if (job.deliverChannel !== undefined) configDelivery.set(job.name, job.deliverChannel)
  }
  const domain = await ctx.storageDomain.open(cronDomainSpec)
  const registry = createJobRegistry({
    configJobs: resolved.jobs,
    configDelivery,
    jobsTable: domain.table('jobs'),
    stateTable: domain.table('state'),
    guardrails: {
      allowedAgentPresets: resolved.allowedAgentPresets,
      allowedPermissionPresets: resolved.allowedPermissionPresets,
      allowedWorkspaceRoots: resolved.allowedWorkspaceRoots,
      maxStoredJobs: resolved.maxStoredJobs,
      minIntervalMs: resolved.minIntervalMs,
      notesMaxChars: resolved.notesMaxChars,
    },
  })
  const handoffs = new Map<string, Promise<void>>()
  function deliver(payload: CronRunFinished): Promise<void> {
    const current = handoffs.get(payload.sessionId)
    if (current !== undefined) return current
    const operation = Promise.resolve().then(async () => {
      const accepted = await ctx.serial('cron/run-finished', payload)
      if (payload.deliverChannelId !== undefined && accepted !== true) {
        throw new Error(`dsh-cron: job "${payload.jobName}" has no delivery listener accepting its outcome`)
      }
      await registry.acknowledgeOutcome(payload.jobName, payload.sessionId)
    }).finally(() => { handoffs.delete(payload.sessionId) })
    handoffs.set(payload.sessionId, operation)
    return operation
  }
  const host = createSchedulerHost(ctx, {
    turnTimeoutMs: resolved.turnTimeoutMs,
    maxLiveRuns: resolved.maxLiveRuns,
    resolveJob(name) {
      const job = registry.find(name)
      return job?.enabled === true ? job : undefined
    },
    async onStarting(job, firedAt, sessionId) {
      const pending = registry.pendingOutcome(job.name)
      if (pending !== undefined) await deliver(pending)
      await registry.beginRun(job.name, {
        firedAt, sessionId, reportOutcome: resolved.deliverOutcomes,
        ...(job.deliverChannelId === undefined ? {} : { deliverChannelId: job.deliverChannelId }),
      })
    },
    async onSettled(job, _firedAt, result) {
      await deliver(await registry.settleRun(job.name, result, resolved.keepRunHistory))
    },
  }, scheduler)
  const deliveryController = new AbortController()
  async function retryOutcomes(outcomes: readonly CronRunFinished[]): Promise<void> {
    for (const pending of outcomes) {
      if (deliveryController.signal.aborted) break
      try {
        await deliver(pending)
      } catch (error: unknown) {
        ctx.logger.error(`dsh-cron: job "${pending.jobName}" outcome delivery remains pending: ${errorChain(error)}`)
      }
    }
  }
  const retryTimer = setInterval(() => {
    void retryOutcomes([...domain.table('state').keys()].flatMap((name) => {
      const pending = registry.pendingOutcome(name)
      return pending === undefined ? [] : [pending]
    }))
  }, resolved.deliveryRetryMs)
  ctx.effect(() => async () => {
    deliveryController.abort()
    clearInterval(retryTimer)
    await host.dispose()
    await Promise.allSettled(handoffs.values())
    await domain.close()
  }, 'dsh-cron scheduled jobs')
  await retryOutcomes(await registry.recoverRuns(resolved.keepRunHistory))
  if (deliveryController.signal.aborted) return
  host.sync(registry.list().filter(job => job.enabled))

  ctx.on('domain/changed', (change) => {
    // The `jobs` table holds stored definitions and the `state` table holds arm state for both
    // origins, so a write to either can change which jobs hold timers. Notes rides along in `state`;
    // re-syncing on it only rebuilds timers for a job whose expression is unchanged.
    if (change.domain === 'cron_jobs' && (change.table === 'jobs' || change.table === 'state')) {
      host.sync(registry.list().filter(job => job.enabled))
    }
  })
  const runNow = (name: string): boolean => host.trigger(name)
  ctx.tools.register(createCronManageTool(ctx, registry, { requireApproval: resolved.requireApproval, runNow }))
  registerCronCommand(ctx, registry, { runNow })

  if (resolved.jobs.length === 0) {
    ctx.logger.info('dsh-cron: mounted with no configured jobs; stored jobs and management stay available')
  }
}
