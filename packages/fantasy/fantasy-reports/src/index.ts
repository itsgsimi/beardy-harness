/**
 * Scheduled weekly Yahoo fantasy reports: live league data, a reviewed research run per report, and
 * delivery through the scheduler's `cron/run-finished` handoff to the Discord outbox.
 * @module @deepseek-ai/dsh-fantasy-reports
 */

import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { cronerScheduler, type Scheduler } from '@deepseek-ai/dsh-cron'
import type { CronRunFinished } from '@deepseek-ai/dsh-cron'
import type { ResearchOwner, ResearchReport, ResearchRunId, ResearchRunView } from '@deepseek-ai/dsh-research/types'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-fantasy'
import type {} from '@deepseek-ai/dsh-research'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { REPORT_MODES, resolveConfig, type Config, type ReportMode, type ResolvedConfig, type ResolvedTeam } from './config.ts'
import { weeklyReportWorkflow, type EarlierReport } from './workflow.ts'

export { Config, DEFAULT_EXCLUDED_HOSTS, REPORT_MODES, resolveConfig } from './config.ts'
export type { ReportMode, ReportScheduleConfig, ResolvedConfig, ResolvedTeam, TeamConfig } from './config.ts'
export { FANTASY_WORKFLOW_NAME, weeklyReportWorkflow } from './workflow.ts'
export type { EarlierReport, WeeklyReportInput } from './workflow.ts'

/** Cordis plugin identity. */
export const name = 'fantasy-reports'
/** Services a scheduled report reads or writes. */
export const inject = ['agents', 'fantasy', 'research', 'sessionPersistence', 'web']

/** One timer: a team, a report mode, and its expression in the configured timezone. */
export interface ReportSchedule {
  readonly team: ResolvedTeam
  readonly mode: ReportMode
  readonly expression: string
  readonly timezone: string
}

/**
 * Expand configured teams into one timer per report mode.
 * @param config - resolved report policy.
 * @returns timers in team and mode order.
 */
export function reportSchedules(config: ResolvedConfig): ReportSchedule[] {
  return config.teams.flatMap(team => REPORT_MODES.map(mode => ({
    team, mode, expression: team.schedule[mode], timezone: config.timezone,
  })))
}

/**
 * Choose where a team's report or notice goes.
 * @param config - resolved report policy.
 * @param team - report's team.
 * @returns the shadow channel when shadow mode is on, otherwise the team's channel.
 */
export function deliveryChannel(config: ResolvedConfig, team: ResolvedTeam): string {
  return config.shadowChannelId ?? team.channelId
}

/** Identity of one scheduled report, parsed from its research query. */
export interface ReportTag {
  readonly team: string
  readonly season: string
  readonly week: number
  readonly mode: ReportMode
}

/**
 * Format the tag that identifies a report run in its research query and request key.
 * @param tag - team, season, week, and mode.
 * @returns bracketed tag text.
 */
export function formatReportTag(tag: ReportTag): string {
  return `[fantasy-report:${tag.team}:${tag.season}:${tag.week}:${tag.mode}]`
}

/**
 * Read the report tag from a research query.
 * @param query - stored research question.
 * @returns the tag, or undefined for other research runs.
 */
export function parseReportTag(query: string): ReportTag | undefined {
  const match = /\[fantasy-report:([a-z][a-z0-9-]*):([0-9]{4}):([0-9]{1,2}):(full|thursday|sunday)\]/u.exec(query)
  if (match === null) return undefined
  return { team: match[1] as string, season: match[2] as string, week: Number(match[3]), mode: match[4] as ReportMode }
}

/**
 * Calendar date of an instant in a timezone.
 * @param at - epoch milliseconds.
 * @param timezone - IANA timezone.
 * @returns `YYYY-MM-DD`.
 */
export function localDate(at: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

/** Result of one scheduled fire, for logs and tests. */
export interface ReportOutcome {
  readonly kind: 'skipped' | 'published' | 'withheld' | 'failed' | 'undelivered'
  readonly reason?: string
  readonly runId?: ResearchRunId
}

/** Per-fire controls supplied by the scheduler. */
export interface ReportFireOptions {
  /** Aborts on plugin disposal. */
  readonly signal: AbortSignal
  /** Next armed fire of the same timer, shown in failure notices. */
  readonly nextFireAt?: string
  /** Awaited immediately before a research run starts; enforces spacing between starts. */
  readonly beforeStart?: () => Promise<void>
}

/** Open the team's durable caller Session, which links every report run of that team. */
async function openCaller(ctx: Context, config: ResolvedConfig, team: ResolvedTeam): Promise<AgentHandle> {
  const sessionId = SessionId(`fantasy-reports-${team.id}`)
  return await ctx.sessionPersistence.stat(sessionId) === undefined
    ? ctx.agents.create({ sessionId, meta: { cwd: config.workspacePath } })
    : ctx.agents.resume({ resumeSessionId: sessionId })
}

/** Earlier completed reports of the same team and season, newest first, bounded by the history count. */
async function earlierReports(ctx: Context, config: ResolvedConfig, owner: ResearchOwner,
  runs: readonly ResearchRunView[]): Promise<EarlierReport[]> {
  const earlier: EarlierReport[] = []
  for (const run of runs) {
    if (earlier.length >= config.historyReports) break
    if (run.phase !== 'completed') continue
    const tag = parseReportTag(run.query) as ReportTag
    let report: ResearchReport
    try {
      report = await ctx.research.report(run.id, owner)
    } catch (error) {
      ctx.logger.warn(`fantasy-reports: earlier report ${run.id} is unreadable and stays out of the history: ${String(error)}`)
      continue
    }
    earlier.push({ runId: run.id, week: tag.week, mode: tag.mode, markdown: report.markdown })
  }
  return earlier
}

/** Resolve after the run reaches a terminal phase; abort rejects. */
async function settledRun(ctx: Context, id: ResearchRunId, owner: ResearchOwner, signal: AbortSignal): Promise<ResearchRunView> {
  const done = Promise.withResolvers<ResearchRunView>()
  const off = ctx.on('research/changed', ({ run }) => { if (run.id === id && run.phase !== 'running') done.resolve(run) })
  const abort = (): void => { done.reject(signal.reason) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    const current = await ctx.research.status(id, owner)
    if (current.phase !== 'running') return current
    return await done.promise
  } finally {
    off()
    signal.removeEventListener('abort', abort)
  }
}

/**
 * Hand one outcome to the delivery listener, retrying until a listener durably accepts it.
 * @param ctx - event bus.
 * @param config - retry policy.
 * @param payload - outcome to deliver.
 * @param signal - aborts waits between attempts.
 * @returns whether a listener accepted the outcome.
 */
export async function handOff(ctx: Context, config: ResolvedConfig, payload: CronRunFinished, signal: AbortSignal): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    try {
      if (await ctx.serial('cron/run-finished', payload) === true) return true
    } catch (error) {
      ctx.logger.warn(`fantasy-reports: ${payload.jobName} handoff attempt ${attempt} failed: ${String(error)}`)
    }
    if (attempt >= config.deliveryAttempts) return false
    await delay(config.deliveryRetryMs, undefined, { signal })
  }
}

/** Resolve the week, skip unscheduled or repeated slots, gather history, and start the research run. */
async function startReport(ctx: Context, config: ResolvedConfig, team: ResolvedTeam, mode: ReportMode, firedAt: number,
  beforeStart: (() => Promise<void>) | undefined): Promise<ReportOutcome | { run: ResearchRunView; owner: ResearchOwner }> {
  const settings = await ctx.fantasy.league(team.leagueKey)
  const weeks = await ctx.fantasy.gameWeeks()
  const date = localDate(firedAt, config.timezone)
  const week = weeks.find(item => item.start <= date && date <= item.end)?.week
  if (week === undefined || week < config.firstWeek || week > config.lastWeek) {
    return { kind: 'skipped', reason: `${date} is outside report weeks ${config.firstWeek}-${config.lastWeek}` }
  }
  const season = settings.league.season
  if (season === undefined) throw new Error('Yahoo league settings have no season')
  const tag = formatReportTag({ team: team.id, season, week, mode })
  const caller = await openCaller(ctx, config, team)
  try {
    const owner = ctx.research.ownerFor(caller.agent.session)
    if (owner.kind !== 'profile') throw new Error('research ownerScope must be profile so report history outlives each run')
    const runs = await ctx.research.list({ owner, query: `[fantasy-report:${team.id}:${season}:`, limit: 200 })
    if (runs.some(item => item.query.includes(tag))) return { kind: 'skipped', reason: `${tag} already has a run` }
    const history = await earlierReports(ctx, config, owner, runs)
    await beforeStart?.()
    const run = await ctx.research.start({
      caller: caller.agent.session, owner, requestKey: tag,
      query: `${team.name} weekly fantasy report, ${season} week ${week} (${mode}) ${tag}`,
      workflow: weeklyReportWorkflow(ctx, config, { team, settings, season, week, mode, firedAt, history }),
    })
    return { run, owner }
  } finally {
    await caller.dispose()
  }
}

/**
 * Run one scheduled report. Outside the configured weeks, or when the slot already has a run, nothing
 * is started or sent. A report reaches Discord only after its research run completes, which requires
 * the workflow's code checks and review policy; any other end sends a failure notice instead.
 * @param ctx - consumer context.
 * @param config - resolved report policy.
 * @param team - configured team.
 * @param mode - report timing.
 * @param firedAt - scheduled fire time.
 * @param options - disposal signal, next fire, and start spacing.
 * @returns what happened, for logs.
 */
export async function runScheduledReport(ctx: Context, config: ResolvedConfig, team: ResolvedTeam, mode: ReportMode,
  firedAt: number, options: ReportFireOptions): Promise<ReportOutcome> {
  const { signal } = options
  const channel = deliveryChannel(config, team)
  const jobName = `${config.shadowChannelId === undefined ? '' : 'shadow-'}fantasy-${team.id}-${mode}`
  const notice = async (runId: string, code: string, reason: string, kind: 'withheld' | 'failed'): Promise<ReportOutcome> => {
    const accepted = await handOff(ctx, config, { jobName, sessionId: runId, firedAt, outcome: 'failed', text: '',
      failure: { code, message: reason }, reportOutcome: true, deliverChannelId: channel,
      ...(options.nextFireAt === undefined ? {} : { nextFireAt: options.nextFireAt }) }, signal)
    if (!accepted) ctx.logger.error(`fantasy-reports: ${jobName} failure notice was not accepted for delivery`)
    return { kind, reason, ...(runId.startsWith('rp-') ? { runId: runId as ResearchRunId } : {}) }
  }
  let started: ReportOutcome | { readonly run: ResearchRunView; readonly owner: ResearchOwner }
  try {
    started = await startReport(ctx, config, team, mode, firedAt, options.beforeStart)
  } catch (error) {
    signal.throwIfAborted()
    return notice(`fantasy-reports-${team.id}`, 'FANTASY_REPORT_FAILED', String(error), 'failed')
  }
  if ('kind' in started) return started
  const { run, owner } = started
  const finished = await settledRun(ctx, run.id, owner, signal)
  if (finished.phase !== 'completed') {
    const reason = finished.reason ?? finished.phase
    return reason.includes('fantasy report withheld:')
      ? notice(run.id, 'FANTASY_REPORT_WITHHELD', reason, 'withheld')
      : notice(run.id, 'FANTASY_REPORT_FAILED', reason, 'failed')
  }
  const report = await ctx.research.report(run.id, owner)
  const text = config.shadowChannelId === undefined ? report.markdown
    : `**Shadow run: native report for ${team.name}.** Sent only to this channel; the team's own channel received nothing from this run.`
      + `\n\n${report.markdown}`
  const accepted = await handOff(ctx, config, { jobName, sessionId: run.id, firedAt, outcome: 'answered', text,
    reportOutcome: true, deliverChannelId: channel }, signal)
  if (!accepted) return { kind: 'undelivered', reason: 'no delivery listener accepted the report', runId: run.id }
  return { kind: 'published', runId: run.id }
}

/**
 * Arm one timer per team and mode, run fires one at a time with the configured spacing between
 * research starts, and drain the queue on disposal.
 * @param ctx - consumer context.
 * @param supplied - loader configuration.
 * @param scheduler - timer factory; the plugin uses croner.
 */
export function mountReports(ctx: Context, supplied: Config, scheduler: Scheduler): void {
  const config = resolveConfig(supplied)
  ctx.effect(() => {
    const stopping = new AbortController()
    let chain: Promise<void> = Promise.resolve()
    let lastStart = Number.NEGATIVE_INFINITY
    const beforeStart = async (): Promise<void> => {
      const wait = lastStart + config.minimumStartGapMs - Date.now()
      if (wait > 0) await delay(wait, undefined, { signal: stopping.signal })
      lastStart = Date.now()
    }
    const jobs = reportSchedules(config).map((row) => {
      const job = scheduler({ expression: row.expression, timezone: row.timezone }, (firedAt) => {
        const next = job.nextRunAt()
        chain = chain.then(async () => {
          const outcome = await runScheduledReport(ctx, config, row.team, row.mode, firedAt, {
            signal: stopping.signal, beforeStart, ...(next === undefined ? {} : { nextFireAt: new Date(next).toISOString() }),
          })
          ctx.logger.info(`fantasy-reports: ${row.team.id} ${row.mode} ${outcome.kind}${outcome.reason === undefined ? '' : `: ${outcome.reason}`}`)
        }).catch((error: unknown) => {
          if (!stopping.signal.aborted) ctx.logger.error(`fantasy-reports: ${row.team.id} ${row.mode} failed: ${String(error)}`)
        })
      })
      return job
    })
    return async () => {
      stopping.abort(new Error('fantasy-reports stopped'))
      for (const job of jobs) job.stop()
      await chain
    }
  }, 'fantasy report schedules')
}

/**
 * Mount the configured report timers.
 * @param ctx - Cordis plugin context.
 * @param config - loader configuration.
 */
export function apply(ctx: Context, config: Config): void {
  mountReports(ctx, config, cronerScheduler)
}
