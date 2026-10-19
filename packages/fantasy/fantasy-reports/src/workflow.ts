/**
 * Weekly report pipeline inside one durable research run: code gathers Yahoo facts, projections over the
 * horizon, the waiver pool and its values, recent form, NFL games, news, the legal lineup, close calls, and
 * moves; small model stages make fixed-choice judgments and write short prose; code validates every answer,
 * degrades bad ones to plain defaults, and renders.
 * @module @deepseek-ai/dsh-fantasy-reports/workflow
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ResearchWorkflow, ResearchWorkflowRun } from '@deepseek-ai/dsh-research'
import type { ResearchWorkflowResult } from '@deepseek-ai/dsh-research/types'
import type { FantasyLeagueSettings, FantasyNflUsage, FantasyPlayer, FantasyTeam, PlayerKey } from '@deepseek-ai/dsh-fantasy/types'
import {
  type Comparison, holdsJsonObject, type ModelCall, parseCalls, parseCheck, parseComparisons, parseSummary, parseWaivers, type WaiverPick,
} from './answers.ts'
import { type PlayerCall, reconcileCalls } from './calls.ts'
import type { ReportMode, ResolvedConfig, ResolvedTeam } from './config.ts'
import { type Deadlines, weekDeadlines } from './deadlines.ts'
import {
  acquisition, basePositions, type ClosePair, closePairs, type Excerpt, freeAgentFallback, lineupCall, plainReason, points, type PoolEntry,
  positionNeeds, slotOf, type WaiverCandidate, waiverShortlist,
} from './facts.ts'
import { type NflFacts, type PoolPlayer, Projections, readNfl, readPool, readRecentPoints, readStanding } from './gather.ts'
import { type LineupAssignment, lineupChanges, optimizeLineup, startingSlots } from './lineup.ts'
import {
  addValue, byeOutlook, dropCosts, type HorizonBase, horizonBase, type HorizonWeek, horizonWeeks, inIr, laterWeekView, rosterRoom,
  tradeChip,
} from './moves.ts'
import { articleQueries, candidateQuery, collectNews, type News, type NewsSubject, rosterQueries } from './news.ts'
import {
  callInstructions, checkInstructions, closeCallInstructions, DATA_MARKER, FANTASY_PROMPT_VERSION, FANTASY_STAGE_SYSTEM_PROMPT,
  summaryInstructions, waiverInstructions,
} from './prompts.ts'
import { type MovePick, renderReport, type SlotComparison } from './render.ts'
import { changesSince, type ReportFacts } from './since.ts'
import { type GameFacts, gameFor, recentForm, type RecentForm } from './signals.ts'

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

/**
 * The latest earlier report of the same week, compared by Thursday and Sunday updates: its parsed facts, or
 * why its evidence could not be read.
 */
export type PreviousReport =
  | { readonly runId: string; readonly mode: ReportMode; readonly facts: ReportFacts }
  | { readonly runId: string; readonly mode: ReportMode; readonly unreadable: string }

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
  /** For Thursday and Sunday updates, the latest earlier completed report of the same week, when one exists. */
  readonly previous?: PreviousReport
}

/**
 * Build the research workflow for one team's weekly report.
 * @param ctx - consumer context with the fantasy, fantasy projection, and web services, and optionally NFL data.
 * @param config - validated report policy.
 * @param input - trusted team, league settings, week, mode, history, and the earlier report of the week.
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

/** Signals beside a player's Yahoo facts: recent points, form, usage, and his report-week game. */
interface Signals {
  readonly form: ReadonlyMap<PlayerKey, RecentForm>
  readonly usage: ReadonlyMap<PlayerKey, readonly FantasyNflUsage[]>
  readonly game: (player: FantasyPlayer) => GameFacts | undefined
}

/** Yahoo facts of one player as every stage sees them; absent fields are null. */
function playerFacts(player: FantasyPlayer, signals: Signals): Record<string, unknown> {
  const form = signals.form.get(player.key)
  const game = signals.game(player)
  return {
    name: player.name, nflTeam: player.nflTeam ?? null,
    positions: player.positions.filter(position => !position.includes('/') && position !== 'IR'),
    status: player.status ?? null, injury: player.injuryNote ?? null, bye: player.byeWeek ?? null,
    projection: player.projectedPoints ?? null,
    recentPoints: form?.points ?? [], recentAverage: form?.average ?? null, form: form?.flag ?? null,
    usage: signals.usage.get(player.key) ?? [],
    game: game === undefined ? null : { opponent: game.opponent, home: game.home, kickoff: new Date(game.kickoff).toISOString(),
      impliedTotal: game.impliedTotal ?? null },
  }
}

/** Compact facts of one roster player as a stage sees them. */
function sheet(id: string, player: FantasyPlayer, lineup: readonly LineupAssignment[], excerpts: readonly Excerpt[],
  week: number, signals: Signals): Record<string, unknown> {
  const slot = slotOf(lineup, id)
  return { id, ...playerFacts(player, signals), yahooSlot: player.selectedSlot ?? null, slotLocked: player.slotLocked === true,
    codeCall: lineupCall(player, slot, week), codeSlot: slot ?? 'BN', excerpts }
}

/** Completed weeks before the report week, oldest first. */
function earlierWeeks(week: number, count: number): number[] {
  return Array.from({ length: Math.min(count, week - 1) }, (_, index) => week - Math.min(count, week - 1) + index)
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
  const season = Number(input.season)
  const projected = new Projections(ctx, run, settings, season, week, caveats)
  const players = new Map((await projected.fill(roster.players, 'the roster')).map((player, index) => [`P${index + 1}`, player]))
  const slots = settings.rosterSlots
  const name = (id: string): string => (players.get(id) as FantasyPlayer).name
  const matchupTeams = matchups.find(matchup => matchup.week === week && matchup.teams.some(entry => entry.key === team.teamKey))?.teams
  const ours = matchupTeams?.find(entry => entry.key === team.teamKey)
  const opponent = matchupTeams?.find(entry => entry.key !== team.teamKey)
  const code = optimizeLineup(players, slots, week)

  const room = rosterRoom(players, slots)
  const weeks = horizonWeeks(week, config.horizonWeeks, config.lastWeek)
  const later = weeks.slice(1)
  const active = [...players].filter(([id, player]) => !inIr(player) && !room.irMoves.includes(id))
  const rosterWeeks: HorizonWeek[] = [{ week, players: new Map(active) }]
  for (const at of later) {
    const views = await projected.fill(active.map(([, player]) => laterWeekView(player, undefined)), `the roster in week ${at}`, at)
    rosterWeeks.push({ week: at, players: new Map(active.map(([id], index) => [id, views[index] as FantasyPlayer])) })
  }
  const byes = byeOutlook(rosterWeeks, slots)
  const chip = tradeChip(rosterWeeks, slots)
  const base = horizonBase(rosterWeeks, slots, room, players)
  const costs = dropCosts(base)

  const needs = positionNeeds(players, code, slots, week)
  let standing: FantasyTeam | undefined
  let read: PoolPlayer[] = []
  let pool: PoolEntry[] = []
  if (config.waiverPositions > 0) {
    standing = await readStanding(ctx, run, team.leagueKey, team.teamKey, caveats)
    read = await readPool(ctx, run, team.leagueKey, { positions: basePositions(slots),
      pointWeeks: earlierWeeks(week, config.waiverPointWeeks).reverse(), count: config.waiverPoolSize }, caveats)
    pool = await valuePool(read, projected, base, weeks)
  }
  const shortlist = waiverShortlist(pool, { positions: config.waiverPositions, candidates: config.waiverCandidates })
  const formWeeks = earlierWeeks(week, config.formWeeks)
  const watched = [...players.values(), ...shortlist.candidates.map(item => item.player)]
  const recent = formWeeks.length === 0 ? new Map<PlayerKey, Map<number, number>>()
    : await readRecentPoints(ctx, run, team.leagueKey, watched, formWeeks, caveats)
  const form = new Map(watched.flatMap(player => recent === undefined ? []
    : [[player.key, recentForm(player, recent.get(player.key) ?? new Map<number, number>(), config.formGapPoints)] as const]))
  const nfl: NflFacts | undefined = await readNfl(ctx, run, season, week, { weeks: formWeeks, players: watched }, caveats)
  const signals: Signals = { form, usage: nfl?.usage ?? new Map(), game: player => gameFor(nfl?.games ?? [], player.nflTeam) }
  const deadlines: Deadlines | undefined = nfl === undefined ? undefined : weekDeadlines(nfl.games, settings)
  const comparison = await slotComparison(ctx, run, players, code, slots, week, opponent, projected, caveats)

  const subjects = new Map<string, NewsSubject>([
    ...[...players].map(([id, player]) => [id, { player,
      queries: rosterQueries(player, input.season, week).slice(0, config.searchesPerPlayer) }] as const),
    ...[...shortlist.candidates].sort((a, b) => b.value.net - a.value.net).slice(0, config.candidateSearches)
      .map(item => [item.id, { player: item.player, queries: [candidateQuery(item.player, input.season, week)] }] as const),
  ])
  const news = await collectNews(ctx, config, subjects, run, config.waiverArticleSearches === 0 || pool.length === 0 ? undefined
    : { queries: articleQueries(input.season, week, config.waiverArticleSearches), pages: config.waiverArticlePages,
      pool: pool.map(entry => entry.player) })
  const excerpts = (id: string): readonly Excerpt[] => news.excerpts.get(id) ?? []
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
      const text = await stages.ask(stage, callInstructions(input.mode, pending), { matchup: matchupFacts,
        players: pending.map(id => sheet(id, players.get(id) as FantasyPlayer, code, excerpts(id), week, signals)) })
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
        starter: { ...sheet(pair.starter, players.get(pair.starter) as FantasyPlayer, lineup, excerpts(pair.starter), week, signals),
          finalCall: (calls.get(pair.starter) as PlayerCall).call },
        bench: { ...sheet(pair.bench, players.get(pair.bench) as FantasyPlayer, lineup, excerpts(pair.bench), week, signals),
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

  const picks: MovePick[] = []
  if (shortlist.candidates.length > 0 && config.waiverPicks > 0) {
    const text = await stages.ask('waivers', waiverInstructions(input.mode, config.waiverPicks), {
      team: { waiverPriority: standing?.waiverPriority ?? null, faabBalance: standing?.faabBalance ?? null,
        teams: settings.league.teamCount ?? null },
      league: { waiverDays: settings.waiverDays ?? null, usesFaab: settings.usesFaab ?? null },
      horizon: weeks, openRosterSpots: room.open, irMoves: room.irMoves.map(name),
      needs: needs.filter(item => item.need > 0).map(item => ({ position: item.position, reasons: item.reasons })),
      byes: byes.map(item => ({ week: item.week, onBye: item.bye.map(name), emptySlots: item.empty })),
      dropCosts: [...costs].sort(([, a], [, b]) => a - b).map(([id, cost]) => ({ player: name(id), cost })),
      candidates: shortlist.candidates.map(item => ({ id: item.id, fills: item.position, ...playerFacts(item.player, signals),
        acquisition: acquisition(item.player), rank: item.player.rank ?? null, percentOwned: item.player.percentOwned ?? null,
        percentOwnedDelta: item.player.percentOwnedDelta ?? null,
        projections: item.weeks.map((view, at) => ({ week: weeks[at] as number, points: view.projectedPoints ?? null })),
        netValue: item.value.net, drop: item.value.drop === undefined ? null : name(item.value.drop),
        articleMentions: news.mentions.get(item.player.key) ?? 0, excerpts: excerpts(item.id) })),
    })
    let answer: WaiverPick[] | undefined
    if (text !== undefined) {
      try {
        answer = parseWaivers(text, new Set(shortlist.candidates.map(item => item.id)), config.waiverPicks)
        stages.record('waivers', 1)
      } catch (error) {
        stages.record('waivers', 0, String(error))
      }
    }
    if (answer === undefined) caveats.push('No waiver ideas: the waiver answer was unusable.')
    picks.push(...pairMoves(answer ?? [], shortlist.candidates, pool, base, room.open, weeks, caveats))
  }

  if (config.checkReasons) {
    const checked = [...calls].filter(([, call]) => call.origin === 'model' && call.sources.length > 0)
    if (checked.length > 0) {
      const text = await stages.ask('reason check', checkInstructions(), { reasons: checked.map(([id, call]) => ({
        id, ...playerFacts(players.get(id) as FantasyPlayer, signals), call: call.call, reason: call.reason,
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

  const facts = currentFacts(roster.players, players, room.irMoves, picks)
  const since = sinceLastReport(input, facts, caveats)
  const moved = lineupChanges(lineup, players, slots)
  const changes = { start: moved.start.map(name), bench: moved.bench.map(name) }
  let summary: string | undefined
  const summaryText = await stages.ask('summary', summaryInstructions(), {
    matchup: { ...matchupFacts, winProbability: ours?.winProbability ?? null },
    lineup: lineup.map(item => ({ slot: item.slot, player: item.player === undefined ? null : name(item.player) })),
    changes,
    calls: [...calls].map(([id, call]) => ({ player: name(id), call: call.call, reason: call.reason })),
    closeCalls: comparisons.map(item => ({ starter: name(item.pair.starter), bench: name(item.pair.bench), text: item.text })),
    waivers: picks.map(item => ({ player: item.candidate.player.name, acquisition: item.kind,
      drop: item.drop === undefined ? null : name(item.drop), reason: item.reason })),
    irMoves: room.irMoves.map(name),
    byes: byes.map(item => ({ week: item.week, onBye: item.bye.map(name), emptySlots: item.empty })),
    sinceLastReport: since ?? null,
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
    comparisons: comparisons.map(({ pair, text, sources }) => ({ pair, text, sources })),
    moves: { enabled: config.waiverPositions > 0, irMoves: room.irMoves, picks, dropCosts: costs,
      ...(standing?.waiverPriority === undefined ? {} : { waiverPriority: standing.waiverPriority }),
      ...(standing?.faabBalance === undefined ? {} : { faabBalance: standing.faabBalance }),
      ...(settings.league.teamCount === undefined ? {} : { teams: settings.league.teamCount }) },
    byes, ...(chip === undefined ? {} : { chip }), weeks, form, game: signals.game,
    ...(deadlines === undefined ? {} : { deadlines }),
    ...(since === undefined ? {} : { since: { mode: (input.previous as PreviousReport).mode, lines: since } }),
    caveats, evidence: news.evidence,
  }, bound)
  return {
    markdown,
    evidence: JSON.stringify({
      workflow: FANTASY_WORKFLOW_NAME, promptVersion: FANTASY_PROMPT_VERSION,
      team: { id: team.id, name: team.name, teamKey: team.teamKey, leagueKey: team.leagueKey },
      season: input.season, week, mode: input.mode, firedAt: input.firedAt,
      yahoo: { settings, roster, matchups, standing: standing ?? null, pool: read },
      projectedPoints: Object.fromEntries(projected.filled),
      horizonProjections: Object.fromEntries([...projected.later].map(([at, filled]) => [at, Object.fromEntries(filled)])),
      history: input.history.map(report => ({ runId: report.runId, week: report.week, mode: report.mode })),
      previous: input.previous === undefined ? null : { runId: input.previous.runId, mode: input.previous.mode,
        readable: 'facts' in input.previous },
      sources: news.evidence.map(source => ({ id: source.id, url: source.url, title: source.title, players: source.players })),
      codeLineup: code, lineup, calls: Object.fromEntries(calls), closeCalls: pairs, comparisons: comparisons.map(item => item.pair.id),
      horizon: weeks, room, byes, tradeChip: chip ?? null, dropCosts: Object.fromEntries(costs),
      poolValues: pool.map(entry => ({ player: entry.player.key, position: entry.position, ...entry.value })),
      waiverShortlist: shortlist.candidates.map(item => ({ id: item.id, position: item.position, player: item.player.key,
        acquisition: acquisition(item.player), net: item.value.net, drop: item.value.drop ?? null })),
      waivers: picks.map(item => item.candidate.id),
      moves: { ...facts.moves, names: facts.names }, articleMentions: Object.fromEntries(news.mentions), articlePages: news.articles,
      recentForm: Object.fromEntries(form), nfl: nfl === undefined ? null : { games: nfl.games, usage: Object.fromEntries(nfl.usage) },
      deadlines: deadlines ?? null, sinceLastReport: since ?? null,
      stages: stages.outcomes, caveats,
    }),
    quality: 'verified_urls',
  }
}

/** Project and value every pool player over the horizon, one projection call per horizon week. */
async function valuePool(read: readonly PoolPlayer[], projected: Projections, base: HorizonBase,
  weeks: readonly number[]): Promise<PoolEntry[]> {
  if (read.length === 0) return []
  const current = await projected.fill(read.map(item => item.player), 'the waiver pool')
  const byWeek = [current]
  for (const at of weeks.slice(1)) {
    byWeek.push(await projected.fill(current.map(player => laterWeekView(player, undefined)), `the waiver pool in week ${at}`, at))
  }
  return read.map((item, index) => {
    const views = byWeek.map(list => list[index] as FantasyPlayer)
    return { position: item.position, player: current[index] as FantasyPlayer, weeks: views, value: addValue(base, `X${index}`, views) }
  })
}

/**
 * Turn waiver picks into moves in pick order: an add uses an open roster spot while one is left, otherwise it
 * drops the cheapest droppable player that no earlier pick drops; a pick with neither, or whose only drops cost
 * more than he adds, is left out with a caveat. A claim also names its free-agent fallback.
 */
function pairMoves(answer: readonly WaiverPick[], candidates: readonly WaiverCandidate[], pool: readonly PoolEntry[], base: HorizonBase,
  open: number, weeks: readonly number[], caveats: string[]): MovePick[] {
  const moves: MovePick[] = []
  const used = new Set<string>()
  const taken = new Set<string>(answer.map(pick => (candidates.find(item => item.id === pick.id) as WaiverCandidate).player.key))
  let left = open
  for (const pick of answer) {
    const candidate = candidates.find(item => item.id === pick.id) as WaiverCandidate
    let drop: string | undefined
    let net = candidate.value.net
    if (left > 0) {
      left--
    } else {
      const paired = addValue({ ...base, full: true, droppable: base.droppable.filter(id => !used.has(id)) }, pick.id, candidate.weeks)
      if (paired.drop === undefined || paired.net <= 0) {
        caveats.push(`The waiver pick ${candidate.player.name} is left out: no open roster spot or worthwhile drop is left after the earlier picks.`)
        continue
      }
      drop = paired.drop
      net = paired.net
      used.add(drop)
    }
    const kind = acquisition(candidate.player)
    const fallback = kind === 'claim' ? freeAgentFallback(pool, candidate, taken) : undefined
    if (fallback !== undefined) taken.add(fallback.player.key)
    moves.push({ candidate, reason: pick.reason, kind, net, weeks: weeks.length,
      ...(drop === undefined ? {} : { drop }), ...(fallback === undefined ? {} : { fallback }) })
  }
  return moves
}

/** This report's roster and suggested moves in the form an earlier report's evidence records them. */
function currentFacts(roster: readonly FantasyPlayer[], players: ReadonlyMap<string, FantasyPlayer>, irMoves: readonly string[],
  picks: readonly MovePick[]): ReportFacts {
  const ir = irMoves.map(id => players.get(id) as FantasyPlayer)
  const added = picks.map(pick => pick.candidate.player)
  return {
    roster: roster.map(player => ({ key: player.key, name: player.name,
      ...(player.status === undefined ? {} : { status: player.status }) })),
    moves: { ir: ir.map(player => player.key), claims: picks.filter(pick => pick.kind === 'claim').map(pick => pick.candidate.player.key),
      adds: picks.filter(pick => pick.kind === 'free agent').map(pick => pick.candidate.player.key) },
    names: Object.fromEntries([...ir, ...added].map(player => [player.key, player.name])),
  }
}

/**
 * Changes since the latest earlier report of the week, for Thursday and Sunday updates. A missing or
 * unreadable earlier report adds a caveat and leaves the section out.
 */
function sinceLastReport(input: WeeklyReportInput, current: ReportFacts, caveats: string[]): string[] | undefined {
  if (input.mode !== 'thursday' && input.mode !== 'sunday') return undefined
  const previous = input.previous
  if (previous === undefined) {
    caveats.push(`No earlier report of week ${input.week} completed, so changes since the last report are not listed.`)
    return undefined
  }
  if ('unreadable' in previous) {
    caveats.push(`The earlier ${previous.mode} report's evidence could not be read (${previous.unreadable}), so changes since it are not listed.`)
    return undefined
  }
  return changesSince(previous.facts, current)
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
