/**
 * Weekly report pipeline inside one durable research run: code gathers Yahoo facts, projections, news,
 * the legal lineup, close calls, and the waiver shortlist; small model stages make fixed-choice judgments and
 * write short prose; code validates every answer, degrades bad ones to plain defaults, and renders.
 * @module @deepseek-ai/dsh-fantasy-reports/workflow
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ResearchWorkflow, ResearchWorkflowRun } from '@deepseek-ai/dsh-research'
import type { ResearchWorkflowResult } from '@deepseek-ai/dsh-research/types'
import type { FantasyLeagueSettings, FantasyPlayer, FantasyTeam, PlayerKey } from '@deepseek-ai/dsh-fantasy/types'
import { scoreStats } from '@deepseek-ai/dsh-fantasy'
import {
  type Comparison, holdsJsonObject, type ModelCall, parseCalls, parseCheck, parseComparisons, parseSummary, parseWaivers, type WaiverPick,
} from './answers.ts'
import { type PlayerCall, reconcileCalls } from './calls.ts'
import type { ReportMode, ResolvedConfig, ResolvedTeam } from './config.ts'
import {
  type ClosePair, closePairs, type Excerpt, lineupCall, plainReason, points, positionNeeds, slotOf, type WaiverCandidate,
  waiverQueries, waiverShortlist,
} from './facts.ts'
import { type LineupAssignment, lineupChanges, optimizeLineup, startingSlots } from './lineup.ts'
import { collectNews, type News } from './news.ts'
import {
  callInstructions, checkInstructions, closeCallInstructions, DATA_MARKER, FANTASY_PROMPT_VERSION, FANTASY_STAGE_SYSTEM_PROMPT,
  summaryInstructions, waiverInstructions,
} from './prompts.ts'
import { renderReport, type SlotComparison } from './render.ts'

/** Workflow name recorded in each report run. */
export const FANTASY_WORKFLOW_NAME = 'fantasy-weekly-report'

/** Characters reserved in the delivery bound for the shadow label. */
export const SHADOW_LABEL_CHARS = 300

/** A completed earlier report shown to the summary stage as comparison data. */
export interface EarlierReport {
  readonly runId: string
  readonly week: number
  readonly mode: ReportMode
  readonly markdown: string
}

/** Trusted facts the scheduled consumer resolved before starting the run. */
export interface WeeklyReportInput {
  readonly team: ResolvedTeam
  readonly settings: FantasyLeagueSettings
  readonly week: number
  readonly mode: ReportMode
  /** League season from Yahoo settings. */
  readonly season: string
  /** Scheduled start time, shown as the report time. */
  readonly firedAt: number
  /** Earlier completed reports of the same team and season, newest first. */
  readonly history: readonly EarlierReport[]
}

/**
 * Build the research workflow for one team's weekly report.
 * @param ctx - consumer context with the fantasy, fantasy projection, and web services.
 * @param config - validated report policy.
 * @param input - trusted team, league settings, week, mode, and history.
 * @returns a workflow that publishes unless the Yahoo facts fail or no model stage answers usably.
 */
export function weeklyReportWorkflow(ctx: Context, config: ResolvedConfig, input: WeeklyReportInput): ResearchWorkflow {
  return {
    name: FANTASY_WORKFLOW_NAME,
    promptVersion: FANTASY_PROMPT_VERSION,
    budgets: { hardRunTimeoutMs: config.runTimeoutMs, stageTimeoutMs: config.stageTimeoutMs },
    stageSystemPrompt: FANTASY_STAGE_SYSTEM_PROMPT,
    run: run => runReport(ctx, config, input, run),
  }
}

/** Error text of a report the workflow refuses to publish. */
function withheld(reason: string): Error {
  return new Error(`fantasy report withheld: ${reason}`)
}

/** One model stage's outcome, kept in the run's evidence. */
interface StageOutcome {
  readonly stage: string
  /** Whether the answer yielded at least one usable item. */
  readonly usable: boolean
  readonly detail?: string
}

/** Model stages of one run and their outcomes. */
class Stages {
  readonly outcomes: StageOutcome[] = []
  /** Usable model items: calls, comparisons, a waiver answer, a summary, and a check answer. */
  successes = 0

  constructor(private readonly run: ResearchWorkflowRun, private readonly maxTokens: number) {}

  /**
   * Run one stage; a stage error other than the run's own abort becomes an unusable outcome.
   * @returns the answer text, or undefined after a stage error.
   */
  async ask(stage: string, instructions: string, data: unknown): Promise<string | undefined> {
    try {
      return await this.run.stage(`${instructions}\n\n${DATA_MARKER}\n${JSON.stringify(data)}`, this.maxTokens,
        { expectJson: holdsJsonObject })
    } catch (error) {
      this.run.signal.throwIfAborted()
      this.record(stage, 0, `stage error: ${String(error)}`)
      return undefined
    }
  }

  record(stage: string, usable: number, detail?: string): void {
    this.successes += usable
    this.outcomes.push({ stage, usable: usable > 0, ...(detail === undefined ? {} : { detail }) })
  }
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, index * size + size))
}

/** Yahoo facts of one player as every stage sees them; absent Yahoo fields are null. */
function playerFacts(player: FantasyPlayer): Record<string, unknown> {
  return {
    name: player.name, nflTeam: player.nflTeam ?? null,
    positions: player.positions.filter(position => !position.includes('/') && position !== 'IR'),
    status: player.status ?? null, injury: player.injuryNote ?? null, bye: player.byeWeek ?? null,
    projection: player.projectedPoints ?? null,
  }
}

/** Compact facts of one roster player as a stage sees them. */
function sheet(id: string, player: FantasyPlayer, lineup: readonly LineupAssignment[], excerpts: readonly Excerpt[],
  week: number): Record<string, unknown> {
  const slot = slotOf(lineup, id)
  return { id, ...playerFacts(player), yahooSlot: player.selectedSlot ?? null, slotLocked: player.slotLocked === true,
    codeCall: lineupCall(player, slot, week), codeSlot: slot ?? 'BN', excerpts }
}

async function runReport(ctx: Context, config: ResolvedConfig, input: WeeklyReportInput,
  run: ResearchWorkflowRun): Promise<ResearchWorkflowResult> {
  const { team, settings, week } = input
  const [roster, matchups] = await Promise.all([
    ctx.fantasy.team(team.teamKey, week, run.signal), ctx.fantasy.matchups(team.teamKey, week, run.signal),
  ])
  if (settings.league.key !== team.leagueKey || roster.team.key !== team.teamKey || roster.week !== week) {
    throw withheld('Yahoo returned a different league, team, or week than requested')
  }
  if (roster.players.length === 0 || roster.players.length > config.maxPlayers) {
    throw withheld(`the Yahoo roster has ${roster.players.length} players; reports cover 1 to ${config.maxPlayers}`)
  }
  const caveats: string[] = []
  const projected = new Projections(ctx, run, settings, Number(input.season), week, caveats)
  const players = new Map((await projected.fill(roster.players, 'the roster')).map((player, index) => [`P${index + 1}`, player]))
  const slots = settings.rosterSlots
  const name = (id: string): string => (players.get(id) as FantasyPlayer).name
  const matchupTeams = matchups.find(matchup => matchup.week === week && matchup.teams.some(entry => entry.key === team.teamKey))?.teams
  const ours = matchupTeams?.find(entry => entry.key === team.teamKey)
  const opponent = matchupTeams?.find(entry => entry.key !== team.teamKey)
  const code = optimizeLineup(players, slots, week)

  const needs = positionNeeds(players, code, slots, week)
  const freeAgents = new Map<string, readonly FantasyPlayer[]>()
  const yahooFreeAgents = new Map<string, readonly FantasyPlayer[]>()
  if (config.waiverPositions > 0) {
    for (const position of waiverQueries(needs, players)) {
      try {
        const available = await ctx.fantasy.players(team.leagueKey, { status: 'FA', position, sort: 'rank', start: 0,
          count: Math.min(25, config.waiverCandidates * 3), week }, run.signal)
        yahooFreeAgents.set(position, available)
        freeAgents.set(position, await projected.fill(available, `free agents at ${position}`))
      } catch (error) {
        run.signal.throwIfAborted()
        caveats.push(`Yahoo free agents at ${position} could not be read (${String(error)}).`)
      }
    }
  }
  const shortlist = waiverShortlist(needs, freeAgents, players, code, week,
    { positions: config.waiverPositions, candidates: config.waiverCandidates })
  const comparison = await slotComparison(ctx, run, players, code, slots, week, opponent, projected, caveats)

  const news = await collectNews(ctx, config, players, { season: input.season, week }, run)
  const excerpts = (id: string): readonly Excerpt[] => news.excerpts.get(id) as readonly Excerpt[]
  const stages = new Stages(run, config.stageMaxTokens)
  const matchupFacts = { week, team: team.name, opponent: opponent?.name ?? null,
    projected: { team: ours?.projectedPoints ?? null, opponent: opponent?.projectedPoints ?? null } }

  const model = new Map<string, ModelCall>()
  const invalid = new Map<string, string>()
  for (const [index, batch] of chunks([...players.keys()], config.playersPerStage).entries()) {
    let pending = batch
    for (let round = 0; round < 2 && pending.length > 0; round++) {
      const stage = `calls ${index + 1}${round === 0 ? '' : ' retry'}`
      const shown = new Map(pending.map(id => [id, new Set(excerpts(id).map(item => item.source))]))
      const text = await stages.ask(stage, callInstructions(input.mode, pending),
        { matchup: matchupFacts, players: pending.map(id => sheet(id, players.get(id) as FantasyPlayer, code, excerpts(id), week)) })
      if (text === undefined) {
        for (const id of pending) invalid.set(id, 'stage error')
        continue
      }
      const answers = parseCalls(text, shown)
      for (const [id, call] of answers.valid) {
        model.set(id, call)
        invalid.delete(id)
      }
      for (const [id, reason] of answers.invalid) invalid.set(id, reason)
      stages.record(stage, answers.valid.size, answers.invalid.size === 0 ? undefined
        : `invalid: ${[...answers.invalid].map(([id, reason]) => `${id} (${reason})`).join('; ')}`)
      pending = [...answers.invalid.keys()]
    }
  }
  const reconciled = reconcileCalls(players, slots, week, code, model)
  const calls = new Map(reconciled.calls)
  const lineup = reconciled.lineup

  const pairs = config.maxCloseCalls === 0 ? [] : closePairs(players, lineup, week, config.closeCallMargin, config.maxCloseCalls)
  const comparisons: Array<{ pair: ClosePair } & Comparison> = []
  if (pairs.length > 0) {
    const shown = new Map(pairs.map(pair => [pair.id,
      new Set([...excerpts(pair.starter), ...excerpts(pair.bench)].map(item => item.source))]))
    const text = await stages.ask('close calls', closeCallInstructions(pairs.map(pair => pair.id)), {
      matchup: matchupFacts,
      pairs: pairs.map(pair => ({ id: pair.id, slot: pair.slot, flagged: pair.why === 'status' ? 'uncertain starter' : 'close projections',
        starter: { ...sheet(pair.starter, players.get(pair.starter) as FantasyPlayer, lineup, excerpts(pair.starter), week),
          finalCall: (calls.get(pair.starter) as PlayerCall).call },
        bench: { ...sheet(pair.bench, players.get(pair.bench) as FantasyPlayer, lineup, excerpts(pair.bench), week),
          finalCall: (calls.get(pair.bench) as PlayerCall).call } })),
    })
    if (text !== undefined) {
      try {
        const valid = parseComparisons(text, shown)
        for (const pair of pairs) {
          const found = valid.get(pair.id)
          if (found !== undefined) comparisons.push({ pair, ...found })
        }
        stages.record('close calls', valid.size)
      } catch (error) {
        stages.record('close calls', 0, String(error))
      }
    }
    for (const pair of pairs) {
      if (!comparisons.some(item => item.pair === pair)) {
        caveats.push(`No comparison of ${name(pair.starter)} and ${name(pair.bench)}: the close-call answer was unusable.`)
      }
    }
  }

  const waivers: Array<{ candidate: WaiverCandidate; reason: string }> = []
  if (shortlist.candidates.length > 0 && config.waiverPicks > 0) {
    const text = await stages.ask('waivers', waiverInstructions(config.waiverPicks), {
      positions: shortlist.positions.map(weak => ({ position: weak.position, reasons: weak.reasons, projectionGap: weak.gap ?? null })),
      candidates: shortlist.candidates.map(({ id, position, player }) => ({ id, fills: position, ...playerFacts(player),
        rank: player.rank ?? null, percentOwned: player.percentOwned ?? null })),
    })
    let picks: WaiverPick[] | undefined
    if (text !== undefined) {
      try {
        picks = parseWaivers(text, new Set(shortlist.candidates.map(item => item.id)), config.waiverPicks)
        stages.record('waivers', 1)
      } catch (error) {
        stages.record('waivers', 0, String(error))
      }
    }
    if (picks === undefined) caveats.push('No waiver ideas: the waiver answer was unusable.')
    for (const pick of picks ?? []) {
      waivers.push({ candidate: shortlist.candidates.find(item => item.id === pick.id) as WaiverCandidate, reason: pick.reason })
    }
  }

  if (config.checkReasons) {
    const checked = [...calls].filter(([, call]) => call.origin === 'model' && call.sources.length > 0)
    if (checked.length > 0) {
      const text = await stages.ask('reason check', checkInstructions(), { reasons: checked.map(([id, call]) => ({
        id, ...playerFacts(players.get(id) as FantasyPlayer), call: call.call, reason: call.reason,
        excerpts: excerpts(id).filter(item => call.sources.includes(item.source)) })) })
      let flagged: Set<string> | undefined
      if (text !== undefined) {
        try {
          flagged = parseCheck(text, new Set(checked.map(([id]) => id)))
          stages.record('reason check', 1)
        } catch (error) {
          stages.record('reason check', 0, String(error))
        }
      }
      if (flagged === undefined) caveats.push('The reason check did not run: its answer was unusable.')
      for (const id of flagged ?? []) {
        const player = players.get(id) as FantasyPlayer
        calls.set(id, { ...(calls.get(id) as PlayerCall), reason: plainReason(player, slotOf(lineup, id), week), sources: [],
          origin: 'unsupported' })
      }
    }
  }

  const moved = lineupChanges(lineup, players, slots)
  const changes = { start: moved.start.map(name), bench: moved.bench.map(name) }
  let summary: string | undefined
  const summaryText = await stages.ask('summary', summaryInstructions(), {
    matchup: { ...matchupFacts, winProbability: ours?.winProbability ?? null },
    lineup: lineup.map(item => ({ slot: item.slot, player: item.player === undefined ? null : name(item.player) })),
    changes,
    calls: [...calls].map(([id, call]) => ({ player: name(id), call: call.call, reason: call.reason })),
    closeCalls: comparisons.map(item => ({ starter: name(item.pair.starter), bench: name(item.pair.bench), text: item.text })),
    waivers: waivers.map(item => ({ player: item.candidate.player.name, reason: item.reason })),
    earlierReports: historyText(input.history, config.historyChars),
  })
  if (summaryText !== undefined) {
    try {
      summary = parseSummary(summaryText)
      stages.record('summary', 1)
    } catch (error) {
      stages.record('summary', 0, String(error))
    }
  }
  if (summary === undefined) caveats.push('The summary is written by code: the summary answer was unusable.')

  if (stages.successes === 0) {
    const reason = stages.outcomes.find(outcome => outcome.detail !== undefined)?.detail as string
    throw withheld(`no model stage returned a usable answer (${reason})`)
  }
  caveats.unshift(...rowCaveats(players, calls, lineup, news, invalid))
  const bound = config.maxDeliveryChars - SHADOW_LABEL_CHARS
  const markdown = renderReport({
    teamName: team.name, season: input.season, week, mode: input.mode, firedAt: input.firedAt, timezone: config.timezone,
    players, slots, ...(ours === undefined || opponent === undefined ? {} : { matchup: { ours, opponent } }),
    ...(comparison === undefined ? {} : { comparison }),
    summary: summary ?? codeSummary(team.name, opponent, ours, changes), lineup, calls,
    comparisons: comparisons.map(({ pair, text, sources }) => ({ pair, text, sources })), waivers, caveats, evidence: news.evidence,
  }, bound)
  return {
    markdown,
    evidence: JSON.stringify({
      workflow: FANTASY_WORKFLOW_NAME, promptVersion: FANTASY_PROMPT_VERSION,
      team: { id: team.id, name: team.name, teamKey: team.teamKey, leagueKey: team.leagueKey },
      season: input.season, week, mode: input.mode, firedAt: input.firedAt,
      yahoo: { settings, roster, matchups, freeAgents: Object.fromEntries(yahooFreeAgents) },
      projectedPoints: Object.fromEntries(projected.filled),
      history: input.history.map(report => ({ runId: report.runId, week: report.week, mode: report.mode })),
      sources: news.evidence.map(source => ({ id: source.id, url: source.url, title: source.title, players: source.players })),
      codeLineup: code, lineup, calls: Object.fromEntries(calls), closeCalls: pairs, comparisons: comparisons.map(item => item.pair.id),
      waiverShortlist: shortlist.candidates.map(item => ({ id: item.id, position: item.position, player: item.player.key })),
      waivers: waivers.map(item => item.candidate.id), stages: stages.outcomes, caveats,
    }),
    quality: 'verified_urls',
  }
}

/**
 * Projections from the projection provider, scored under league scoring, for players Yahoo left unprojected.
 * A failed projection read leaves its players as Yahoo returned them and adds a caveat.
 */
class Projections {
  /** Points filled from provider stat lines, by player key, for the run's evidence. */
  readonly filled = new Map<PlayerKey, number>()

  constructor(private readonly ctx: Context, private readonly run: ResearchWorkflowRun, private readonly settings: FantasyLeagueSettings,
    private readonly season: number, private readonly week: number, private readonly caveats: string[]) {}

  /**
   * Project one player list in a single provider call.
   * @param players - players as Yahoo returned them.
   * @param label - what the list is, for the failure caveat.
   * @returns the players, with `projectedPoints` set where Yahoo left it undefined and the provider matched them.
   */
  async fill(players: readonly FantasyPlayer[], label: string): Promise<FantasyPlayer[]> {
    let lines: ReadonlyMap<PlayerKey, Readonly<Record<string, number>>>
    try {
      lines = await this.ctx.fantasyProjections.project(this.season, this.week, players, this.run.signal)
    } catch (error) {
      this.run.signal.throwIfAborted()
      this.caveats.push(`Projections for ${label} could not be read (${String(error)}).`)
      return [...players]
    }
    return players.map((player) => {
      const line = lines.get(player.key)
      if (player.projectedPoints !== undefined || line === undefined) return player
      const projectedPoints = scoreStats(line, this.settings.scoring)
      this.filled.set(player.key, projectedPoints)
      return { ...player, projectedPoints }
    })
  }
}

/** Slot-by-slot projections of the report lineup and the opponent's Yahoo starters, when a roster player is projected. */
async function slotComparison(ctx: Context, run: ResearchWorkflowRun, players: ReadonlyMap<string, FantasyPlayer>,
  lineup: readonly LineupAssignment[], slots: FantasyLeagueSettings['rosterSlots'], week: number, opponent: FantasyTeam | undefined,
  projected: Projections, caveats: string[]): Promise<SlotComparison[] | undefined> {
  if (opponent === undefined || ![...players.values()].some(player => player.projectedPoints !== undefined)) return undefined
  let theirs: readonly FantasyPlayer[]
  try {
    theirs = await projected.fill((await ctx.fantasy.team(opponent.key, week, run.signal)).players, "the opponent's roster")
  } catch (error) {
    run.signal.throwIfAborted()
    caveats.push(`The opponent's Yahoo roster could not be read, so the slot comparison is missing (${String(error)}).`)
    return undefined
  }
  const starting = startingSlots(slots)
  return [...new Set(starting)].map(slot => ({
    slot,
    ours: lineup.reduce((sum, item) => sum + (item.slot === slot && item.player !== undefined
      ? (players.get(item.player) as FantasyPlayer).projectedPoints ?? 0 : 0), 0),
    theirs: theirs.reduce((sum, player) => sum + ((player.selectedSlot ?? '').toUpperCase() === slot ? player.projectedPoints ?? 0 : 0), 0),
  }))
}

/** Caveats about rows code decided: missing news, defaults, rejected calls, failed reason checks, empty slots, and failed fetches. */
function rowCaveats(players: ReadonlyMap<string, FantasyPlayer>, calls: ReadonlyMap<string, PlayerCall>,
  lineup: readonly LineupAssignment[], news: News, invalid: ReadonlyMap<string, string>): string[] {
  const named = (ids: readonly string[]): string => ids.map(id => (players.get(id) as FantasyPlayer).name).join(', ')
  const by = (origin: PlayerCall['origin']): string[] => [...calls].filter(([, call]) => call.origin === origin).map(([id]) => id)
  const caveats: string[] = []
  const unsourced = [...players.keys()].filter(id => (news.excerpts.get(id) as readonly Excerpt[]).length === 0)
  if (unsourced.length > 0) caveats.push(`No current news page was admitted for ${named(unsourced)}; their calls rest on Yahoo data.`)
  const defaults = by('default')
  if (defaults.length > 0) {
    caveats.push(`Code defaults stand for ${named(defaults)}: no valid model call after one retry (${defaults.map(id =>
      `${id}: ${invalid.get(id) as string}`).join('; ')}).`)
  }
  for (const id of by('overridden')) {
    caveats.push(`Code kept the lineup call for ${named([id])}: the model call was rejected because ${(calls.get(id) as PlayerCall).note as string}.`)
  }
  const unsupported = by('unsupported')
  if (unsupported.length > 0) {
    caveats.push(`The reason check found no support for the model reasons of ${named(unsupported)}; plain code reasons replace them.`)
  }
  for (const item of lineup) if (item.player === undefined) caveats.push(`No eligible player can fill ${item.slot} this week.`)
  if (news.failedFetches > 0) caveats.push(`News pages that failed to load: ${news.failedFetches}.`)
  return caveats
}

/** Summary written by code when the summary stage answer is unusable. */
function codeSummary(teamName: string, opponent: FantasyTeam | undefined, ours: FantasyTeam | undefined,
  changes: { readonly start: readonly string[]; readonly bench: readonly string[] }): string {
  const matchup = opponent === undefined ? `${teamName} has no Yahoo matchup this week.`
    : `${teamName} faces ${opponent.name}; Yahoo projects ${points(ours?.projectedPoints)} to ${points(opponent.projectedPoints)}.`
  const moves = [...changes.start.map(item => `start ${item}`), ...changes.bench.map(item => `bench ${item}`)]
  const lineup = moves.length === 0 ? 'The suggested lineup keeps every current Yahoo starter.' : `Suggested lineup changes: ${moves.join(', ')}.`
  return `${matchup} ${lineup}`
}

function historyText(history: readonly EarlierReport[], maxChars: number): string {
  if (history.length === 0 || maxChars === 0) return 'None supplied; this report is the baseline.'
  const each = Math.floor(maxChars / history.length)
  return history.map(report => `--- Earlier week ${report.week} ${report.mode} report ---\n${report.markdown.slice(0, each)}`).join('\n\n')
}
