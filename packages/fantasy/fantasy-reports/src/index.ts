/**
 * Scheduled weekly Yahoo fantasy reports: live league data, one research run per report that mixes
 * code decisions with small logged model stages, and delivery through the scheduler's `cron/run-finished` handoff to the Discord outbox.
 * @module @deepseek-ai/dsh-fantasy-reports
 */

import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { cronerScheduler, latestMatchAt, type Scheduler, type ScheduledJob } from '@deepseek-ai/dsh-cron'
import type { CronRunFinished } from '@deepseek-ai/dsh-cron'
import type { ResearchOwner, ResearchReport, ResearchRunId, ResearchRunView } from '@deepseek-ai/dsh-research/types'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-commands'
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
/** Services a report reads or writes, and the registry of the on-demand command. */
export const inject = ['agents', 'commands', 'fantasy', 'fantasyProjections', 'research', 'sessionPersistence', 'web']

/** Human command that runs one team's report now. */
export const REPORT_COMMAND = 'fantasy-report'

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

/** What started a report run: its timer, the restart catch-up, or the human `/fantasy-report` command. */
export type ReportTrigger = 'scheduled' | 'catch-up' | 'manual'

/** Identity of one scheduled report, parsed from its research query. */
export interface ReportTag {
  readonly team: string
  readonly season: string
  readonly week: number
  readonly mode: ReportMode
  /**
   * What started the run and the fire time its delivery handoff carries. The short tag form, which
   * names only the slot, has none.
   */
  readonly fire?: { readonly trigger: ReportTrigger; readonly at: number }
}

/**
 * Format the tag that identifies a report run in its research query and request key.
 * @param tag - team, season, week, mode, and optionally the fire.
 * @returns bracketed tag text; without a fire it names only the slot.
 */
export function formatReportTag(tag: ReportTag): string {
  const fire = tag.fire === undefined ? '' : `:${tag.fire.trigger}:${tag.fire.at}`
  return `[fantasy-report:${tag.team}:${tag.season}:${tag.week}:${tag.mode}${fire}]`
}

/** Slot fields, then the optional trigger and fire time of the full tag form. */
const REPORT_TAG = new RegExp(String.raw`\[fantasy-report:([a-z][a-z0-9-]*):([0-9]{4}):([0-9]{1,2}):(full|thursday|sunday)`
  + String.raw`(?::(scheduled|catch-up|manual):([0-9]+))?\]`, 'u')

/**
 * Read the report tag from a research query.
 * @param query - stored research question.
 * @returns the tag, or undefined for other research runs.
 */
export function parseReportTag(query: string): ReportTag | undefined {
  const match = REPORT_TAG.exec(query)
  if (match === null) return undefined
  return { team: match[1] as string, season: match[2] as string, week: Number(match[3]), mode: match[4] as ReportMode,
    ...(match[5] === undefined ? {} : { fire: { trigger: match[5] as ReportTrigger, at: Number(match[6]) } }) }
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

/** A team's latest scheduled slot, revisited once when the plugin starts. */
export interface CatchUpSlot {
  readonly team: ResolvedTeam
  readonly mode: ReportMode
  /** Scheduled time of the slot. */
  readonly slotAt: number
}

/**
 * How long after its slot a report may still be caught up.
 * @param config - resolved report policy.
 * @param mode - slot's report mode.
 * @returns the window in milliseconds; Sunday uses the tighter of its own and the general window.
 */
export function catchUpWindow(config: ResolvedConfig, mode: ReportMode): number {
  return mode === 'sunday' ? Math.min(config.catchUpWindowMs, config.sundayCatchUpWindowMs) : config.catchUpWindowMs
}

/**
 * Pick each team's latest slot at or before an instant when that slot is still inside its catch-up
 * window. Earlier slots of the week are superseded by the latest one and are never caught up.
 * @param config - resolved report policy.
 * @param now - plugin start time in epoch milliseconds.
 * @returns at most one slot per team, in team order.
 */
export function catchUpSlots(config: ResolvedConfig, now: number): CatchUpSlot[] {
  return config.teams.flatMap((team) => {
    const slots = REPORT_MODES.flatMap((mode) => {
      const slotAt = latestMatchAt(team.schedule[mode], config.timezone, now)
      return slotAt === undefined ? [] : [{ team, mode, slotAt }]
    })
    const latest = slots.reduce<CatchUpSlot | undefined>((best, slot) => best === undefined || slot.slotAt > best.slotAt ? slot : best,
      undefined)
    return latest !== undefined && now - latest.slotAt < catchUpWindow(config, latest.mode) ? [latest] : []
  })
}

/** Result of one scheduled fire or catch-up, for logs and tests. */
export interface ReportOutcome {
  /** `redelivered` hands an already completed report to delivery again under its original fire. */
  readonly kind: 'skipped' | 'published' | 'redelivered' | 'withheld' | 'failed' | 'undelivered'
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
  /**
   * Present for a restart catch-up: the slot it revisits, and whether its window is still open once
   * start spacing has elapsed.
   */
  readonly catchUp?: { readonly slotAt: number; readonly open: () => boolean }
  /**
   * Set for a `/fantasy-report` request: the run starts even when its week and mode already have runs,
   * and a date outside the report weeks fails with a notice instead of a silent skip.
   */
  readonly manual?: boolean
}

/**
 * Open the team's durable caller Session, which links every report run of that team. The caller is
 * `fantasy-reports-<team>` while its stored cwd equals `workspacePath`; after `workspacePath` moves,
 * the team uses `fantasy-reports-<team>-<first 8 hex of the path's SHA-256>` instead, leaving the
 * earlier caller Session unchanged. Report history is profile-owned, so it spans both callers.
 */
async function openCaller(ctx: Context, config: ResolvedConfig, team: ResolvedTeam): Promise<AgentHandle> {
  const cwd = resolve(config.workspacePath)
  const original = SessionId(`fantasy-reports-${team.id}`)
  const stored = await ctx.sessionPersistence.stat(original)
  const sessionId = stored?.header.cwd === undefined || resolve(stored.header.cwd) === cwd
    ? original
    : SessionId(`${original}-${createHash('sha256').update(cwd).digest('hex').slice(0, 8)}`)
  const existing = sessionId === original ? stored : await ctx.sessionPersistence.stat(sessionId)
  return existing === undefined
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

/** A run to start, or a completed run whose report goes to delivery again. */
type Started =
  | { readonly kind: 'started'; readonly run: ResearchRunView; readonly owner: ResearchOwner }
  | { readonly kind: 'completed'; readonly run: ResearchRunView; readonly owner: ResearchOwner; readonly firedAt: number }

/**
 * Decide what a catch-up does with the runs its slot already has: repeat the delivery of a completed
 * report under its recorded fire, or start once when every earlier run was interrupted.
 */
function catchUpDecision(slot: string, runs: readonly ResearchRunView[], owner: ResearchOwner): ReportOutcome | Started | undefined {
  const completed = runs.find(run => run.phase === 'completed')
  if (completed !== undefined) {
    const fire = parseReportTag(completed.query)?.fire
    if (fire === undefined) return { kind: 'skipped', reason: `${slot} completed without a recorded fire, so its delivery is not repeated` }
    return { kind: 'completed', run: completed, owner, firedAt: fire.at }
  }
  if (runs.some(run => parseReportTag(run.query)?.fire?.trigger === 'catch-up')) {
    return { kind: 'skipped', reason: `${slot} was already caught up once` }
  }
  const settled = runs.find(run => run.phase !== 'interrupted')
  if (settled !== undefined) return { kind: 'skipped', reason: `${slot} already has a ${settled.phase} run` }
  return undefined
}

/** Resolve the week, skip unscheduled or repeated slots, gather history, and start the research run. */
async function startReport(ctx: Context, config: ResolvedConfig, team: ResolvedTeam, mode: ReportMode, firedAt: number,
  options: ReportFireOptions): Promise<ReportOutcome | Started> {
  const settings = await ctx.fantasy.league(team.leagueKey)
  const weeks = await ctx.fantasy.gameWeeks()
  const date = localDate(options.catchUp?.slotAt ?? firedAt, config.timezone)
  const week = weeks.find(item => item.start <= date && date <= item.end)?.week
  if (week === undefined || week < config.firstWeek || week > config.lastWeek) {
    const reason = `${date} is outside report weeks ${config.firstWeek}-${config.lastWeek}`
    if (options.manual === true) throw new Error(reason)
    return { kind: 'skipped', reason }
  }
  const season = settings.league.season
  if (season === undefined) throw new Error('Yahoo league settings have no season')
  const slot = formatReportTag({ team: team.id, season, week, mode })
  const tag = formatReportTag({ team: team.id, season, week, mode,
    fire: { trigger: options.manual === true ? 'manual' : options.catchUp === undefined ? 'scheduled' : 'catch-up', at: firedAt } })
  const caller = await openCaller(ctx, config, team)
  try {
    const owner = ctx.research.ownerFor(caller.agent.session)
    if (owner.kind !== 'profile') throw new Error('research ownerScope must be profile so report history outlives each run')
    const runs = await ctx.research.list({ owner, query: `[fantasy-report:${team.id}:${season}:`, limit: 200 })
    const slotRuns = runs.filter((run) => {
      const found = parseReportTag(run.query) as ReportTag
      return found.team === team.id && found.season === season && found.week === week && found.mode === mode
        && found.fire?.trigger !== 'manual'
    })
    if (options.manual !== true && options.catchUp === undefined && slotRuns.length > 0) {
      return { kind: 'skipped', reason: `${slot} already has a run` }
    }
    const decision = options.catchUp === undefined ? undefined : catchUpDecision(slot, slotRuns, owner)
    if (decision !== undefined) return decision
    const history = await earlierReports(ctx, config, owner, runs)
    await options.beforeStart?.()
    if (options.catchUp !== undefined && !options.catchUp.open()) {
      return { kind: 'skipped', reason: `the catch-up window of ${slot} closed before its start` }
    }
    const run = await ctx.research.start({
      caller: caller.agent.session, owner, requestKey: tag,
      query: `${team.name} weekly fantasy report, ${season} week ${week} (${mode}) ${tag}`,
      workflow: weeklyReportWorkflow(ctx, config, { team, settings, season, week, mode, firedAt, history }),
    })
    return { kind: 'started', run, owner }
  } finally {
    await caller.dispose()
  }
}

/**
 * Run one scheduled report, restart catch-up, or requested report. Outside the configured weeks, or
 * when the slot already has a scheduled or catch-up run, a scheduled fire starts and sends nothing. A
 * catch-up starts only when every earlier scheduled or catch-up run of its slot was interrupted and
 * none was itself a catch-up, and hands a completed report to delivery again under its original fire,
 * which the listener deduplicates. Manual runs never count toward these slot checks; a manual request
 * always starts, and outside the configured weeks it fails with a notice. A report reaches delivery
 * only after its research run completes, which requires usable Yahoo facts and at least one usable
 * model stage answer; any other end sends a failure notice instead.
 * @param ctx - consumer context.
 * @param config - resolved report policy.
 * @param team - configured team.
 * @param mode - report timing.
 * @param firedAt - scheduled fire time, the catch-up time, or the request time.
 * @param options - disposal signal, next fire, start spacing, catch-up slot, and manual request.
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
  const deliver = async (run: ResearchRunView, owner: ResearchOwner, at: number,
    kind: 'published' | 'redelivered'): Promise<ReportOutcome> => {
    const report = await ctx.research.report(run.id, owner)
    const text = config.shadowChannelId === undefined ? report.markdown
      : `**Shadow run: native report for ${team.name}.** Sent only to this channel; the team's own channel received nothing from this run.`
        + `\n\n${report.markdown}`
    const accepted = await handOff(ctx, config, { jobName, sessionId: run.id, firedAt: at, outcome: 'answered', text,
      reportOutcome: true, deliverChannelId: channel }, signal)
    if (!accepted) return { kind: 'undelivered', reason: 'no delivery listener accepted the report', runId: run.id }
    return { kind, runId: run.id }
  }
  let started: ReportOutcome | Started
  try {
    started = await startReport(ctx, config, team, mode, firedAt, options)
  } catch (error) {
    signal.throwIfAborted()
    return notice(`fantasy-reports-${team.id}`, 'FANTASY_REPORT_FAILED', String(error), 'failed')
  }
  if (started.kind === 'completed') return deliver(started.run, started.owner, started.firedAt, 'redelivered')
  if (started.kind !== 'started') return started
  const { run, owner } = started
  const finished = await settledRun(ctx, run.id, owner, signal)
  if (finished.phase !== 'completed') {
    const reason = finished.reason ?? finished.phase
    return reason.includes('fantasy report withheld:')
      ? notice(run.id, 'FANTASY_REPORT_WITHHELD', reason, 'withheld')
      : notice(run.id, 'FANTASY_REPORT_FAILED', reason, 'failed')
  }
  return deliver(run, owner, firedAt, 'published')
}

/**
 * Log one fire's outcome. A published or redelivered report logs at info; every other outcome logs at
 * warn so a deployment that keeps only warnings still shows each skipped, withheld, failed, or
 * undelivered fire with its reason.
 * @param ctx - logger owner.
 * @param label - team, mode, and trigger of the fire.
 * @param outcome - what the fire did.
 */
export function logOutcome(ctx: Context, label: string, outcome: ReportOutcome): void {
  const line = `fantasy-reports: ${label} ${outcome.kind}${outcome.reason === undefined ? '' : `: ${outcome.reason}`}`
  if (outcome.kind === 'published' || outcome.kind === 'redelivered') ctx.logger.info(line)
  else ctx.logger.warn(line)
}

/** A `/fantasy-report` request the caller's preset may make. */
export interface ReportRequest {
  readonly team: ResolvedTeam
  readonly mode: ReportMode
}

/**
 * Parse `/fantasy-report <team> [full|thursday|sunday]` for a caller preset.
 * @param config - resolved report policy.
 * @param preset - trusted Agent preset recorded on the caller Session.
 * @param rawInput - text after the command name.
 * @returns the team and mode, defaulting to `full`, or the command error to show.
 */
export function parseReportRequest(config: ResolvedConfig, preset: string | undefined,
  rawInput: string): ReportRequest | Extract<CommandResult, { kind: 'error' }> {
  if (preset === undefined || !config.commandPresets.includes(preset)) {
    return { kind: 'error', text: 'Fantasy reports cannot be requested in this lane.' }
  }
  const teams = config.teams.filter(team => team.commandPresets.includes(preset))
  const usage = `Usage: /${REPORT_COMMAND} <${teams.map(team => team.id).join('|')}> [${REPORT_MODES.join('|')}]`
  const [requested, given, ...extra] = rawInput.trim().split(/\s+/u).filter(arg => arg !== '')
  if (requested === undefined || extra.length > 0) return { kind: 'error', text: usage }
  const team = teams.find(item => item.id === requested.toLowerCase())
  if (team === undefined) {
    return { kind: 'error', text: `Unknown team "${requested}". Teams you can request: ${teams.map(item => item.id).join(', ')}.` }
  }
  const mode = (given ?? 'full').toLowerCase()
  if (!(REPORT_MODES as readonly string[]).includes(mode)) return { kind: 'error', text: usage }
  return { team, mode: mode as ReportMode }
}

/**
 * Arm one timer per team and mode, queue each team's restart catch-up, register the on-demand command
 * when `commandPresets` names a preset, run every fire and request one at a time with the configured
 * spacing between scheduled and catch-up research starts, and drain the queue on disposal. A requested
 * report shares the queue, so it never overlaps another report, but neither waits for nor resets the
 * start spacing. A queued or running fire that disposal abandons logs a warning.
 * @param ctx - consumer context.
 * @param supplied - loader configuration.
 * @param scheduler - timer factory; the plugin uses croner.
 * @param clock - current epoch milliseconds for catch-up slots, windows, and request times; the plugin uses `Date.now`.
 */
export function mountReports(ctx: Context, supplied: Config, scheduler: Scheduler, clock: () => number): void {
  const config = resolveConfig(supplied)
  ctx.effect(() => {
    const stopping = new AbortController()
    let chain: Promise<void> = Promise.resolve()
    let queued = 0
    let lastStart = Number.NEGATIVE_INFINITY
    const beforeStart = async (): Promise<void> => {
      const wait = lastStart + config.minimumStartGapMs - Date.now()
      if (wait > 0) await delay(wait, undefined, { signal: stopping.signal })
      lastStart = Date.now()
    }
    const enqueue = (label: string, job: ScheduledJob, fire: (options: ReportFireOptions) => Promise<ReportOutcome>): void => {
      const next = job.nextRunAt()
      queued++
      chain = chain.then(async () => {
        let outcome: ReportOutcome
        try {
          stopping.signal.throwIfAborted()
          outcome = await fire({ signal: stopping.signal, beforeStart,
            ...(next === undefined ? {} : { nextFireAt: new Date(next).toISOString() }) })
        } finally {
          queued--
        }
        logOutcome(ctx, label, outcome)
      }).catch((error: unknown) => {
        if (stopping.signal.aborted) ctx.logger.warn(`fantasy-reports: ${label} abandoned because the plugin stopped`)
        else ctx.logger.error(`fantasy-reports: ${label} failed: ${String(error)}`)
      })
    }
    const jobs = new Map<string, ScheduledJob>()
    for (const row of reportSchedules(config)) {
      const job: ScheduledJob = scheduler({ expression: row.expression, timezone: row.timezone }, (firedAt) => {
        enqueue(`${row.team.id} ${row.mode}`, job, options => runScheduledReport(ctx, config, row.team, row.mode, firedAt, options))
      })
      jobs.set(`${row.team.id} ${row.mode}`, job)
    }
    for (const slot of catchUpSlots(config, clock())) {
      const label = `${slot.team.id} ${slot.mode}`
      const window = catchUpWindow(config, slot.mode)
      enqueue(`${label} catch-up`, jobs.get(label) as ScheduledJob, options => runScheduledReport(ctx, config, slot.team, slot.mode,
        clock(), { ...options, catchUp: { slotAt: slot.slotAt, open: () => clock() - slot.slotAt < window } }))
    }
    const unregister = config.commandPresets.length === 0 ? undefined : ctx.commands.register({
      name: REPORT_COMMAND,
      description: 'Run a team\'s weekly fantasy report now and post it where its scheduled reports go.',
      input: { hint: `<team> [${REPORT_MODES.join('|')}]` },
      handler: (invocation) => {
        const request = parseReportRequest(config, invocation.agent.session.header.agentPreset, invocation.rawInput)
        if ('kind' in request) return request
        const { team, mode } = request
        const ahead = queued
        enqueue(`${team.id} ${mode} manual`, jobs.get(`${team.id} ${mode}`) as ScheduledJob, options => runScheduledReport(ctx, config,
          team, mode, clock(), { ...options, beforeStart: async () => {}, manual: true }))
        const where = config.shadowChannelId === undefined ? 'the team\'s report channel' : 'the shadow channel'
        return { kind: 'success', text: ahead === 0
          ? `Started the ${mode} report for ${team.name}; it will post to ${where} when done.`
          : `Queued the ${mode} report for ${team.name} behind ${ahead} earlier report${ahead === 1 ? '' : 's'}; `
            + `it will post to ${where} when done.` }
      },
    })
    return async () => {
      unregister?.()
      stopping.abort(new Error('fantasy-reports stopped'))
      for (const job of jobs.values()) job.stop()
      await chain
    }
  }, 'fantasy report schedules')
}

/**
 * Mount the configured report timers, the restart catch-up, and the on-demand command.
 * @param ctx - Cordis plugin context.
 * @param config - loader configuration.
 */
export function apply(ctx: Context, config: Config): void {
  mountReports(ctx, config, cronerScheduler, Date.now)
}
