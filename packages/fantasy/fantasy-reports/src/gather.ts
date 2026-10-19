/**
 * Report reads beyond the roster and matchup: projections per horizon week, the team's standings entry, the
 * waiver pool, recent league points, and NFL games and usage. A failed read adds a caveat and leaves its part
 * of the report empty; only the run's own abort propagates.
 * @module @deepseek-ai/dsh-fantasy-reports/gather
 */

import type { Context } from '@deepseek-ai/cordis'
import { scoreStats } from '@deepseek-ai/dsh-fantasy'
import type {
  FantasyLeagueSettings, FantasyNflGame, FantasyNflUsage, FantasyPlayer, FantasyTeam, LeagueKey, PlayerKey, TeamKey,
} from '@deepseek-ai/dsh-fantasy/types'
import type { ResearchWorkflowRun } from '@deepseek-ai/dsh-research'
import { basePosition } from './moves.ts'

/** Yahoo's largest exact-player read. */
const PLAYER_KEYS_PER_READ = 25

/** Run a read; a failure other than the run's abort becomes a caveat and an undefined result. */
async function attempt<T>(run: ResearchWorkflowRun, caveats: string[], what: string, read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read()
  } catch (error) {
    run.signal.throwIfAborted()
    caveats.push(`${what} (${String(error)}).`)
    return undefined
  }
}

/**
 * Projections from the projection provider, scored under league scoring, for players Yahoo left unprojected.
 * A failed projection read leaves its players as given and adds a caveat.
 */
export class Projections {
  /** Report-week points filled from provider stat lines, by player key, for the run's evidence. */
  readonly filled = new Map<PlayerKey, number>()
  /** Later horizon weeks' filled points, by week and player key, for the run's evidence. */
  readonly later = new Map<number, Map<PlayerKey, number>>()

  /**
   * @param ctx - consumer context with the projection service.
   * @param run - research run, for cancellation.
   * @param settings - league scoring.
   * @param season - NFL season year.
   * @param week - report week.
   * @param caveats - report caveats a failed read appends to.
   */
  constructor(private readonly ctx: Context, private readonly run: ResearchWorkflowRun, private readonly settings: FantasyLeagueSettings,
    private readonly season: number, private readonly week: number, private readonly caveats: string[]) {}

  /**
   * Project one player list for one week in a single provider call.
   * @param players - players as that week sees them.
   * @param label - what the list is, for the failure caveat.
   * @param week - projected week; the report week when absent.
   * @returns the players, with `projectedPoints` set where it was undefined and the provider matched them.
   */
  async fill(players: readonly FantasyPlayer[], label: string, week = this.week): Promise<FantasyPlayer[]> {
    const lines = await attempt(this.run, this.caveats, `Projections for ${label} could not be read`,
      () => this.ctx.fantasyProjections.project(this.season, week, players, this.run.signal))
    if (lines === undefined) return [...players]
    const filled = week === this.week ? this.filled : this.later.get(week) ?? new Map<PlayerKey, number>()
    if (week !== this.week) this.later.set(week, filled)
    return players.map((player) => {
      const line = lines.get(player.key)
      if (player.projectedPoints !== undefined || line === undefined) return player
      const projectedPoints = scoreStats(line, this.settings.scoring)
      filled.set(player.key, projectedPoints)
      return { ...player, projectedPoints }
    })
  }
}

/**
 * Read the team's standings entry for its waiver priority and budget.
 * @param ctx - consumer context with the fantasy service.
 * @param run - research run, for cancellation.
 * @param league - league identity.
 * @param team - team identity.
 * @param caveats - report caveats a failed read appends to.
 * @returns the team's entry, or undefined when the read fails or omits the team.
 */
export async function readStanding(ctx: Context, run: ResearchWorkflowRun, league: LeagueKey, team: TeamKey,
  caveats: string[]): Promise<FantasyTeam | undefined> {
  const standings = await attempt(run, caveats, 'Yahoo standings could not be read, so the waiver priority is missing',
    () => ctx.fantasy.standings(league, run.signal))
  return standings?.find(entry => entry.key === team)
}

/** An available player and his base position. */
export interface PoolPlayer {
  readonly position: string
  readonly player: FantasyPlayer
}

/**
 * Read the waiver pool: per base position, Yahoo's season rank list of available players (free agents and
 * waiver claims together) and the top scorers of each recent week, deduplicated by player key. A player's
 * position is his first Yahoo base position among the read positions, otherwise the list that returned him.
 * @param ctx - consumer context with the fantasy service.
 * @param run - research run, for cancellation.
 * @param league - league identity.
 * @param reads - base positions, recent weeks for points lists, and players per list.
 * @param caveats - report caveats a failed position appends to.
 * @returns available players in read order.
 */
export async function readPool(ctx: Context, run: ResearchWorkflowRun, league: LeagueKey,
  reads: { readonly positions: readonly string[]; readonly pointWeeks: readonly number[]; readonly count: number },
  caveats: string[]): Promise<PoolPlayer[]> {
  const pool = new Map<PlayerKey, PoolPlayer>()
  for (const position of reads.positions) {
    const lists = await attempt(run, caveats, `Yahoo available players at ${position} could not be read`, () => Promise.all([
      ctx.fantasy.players(league, { status: 'A', position, sort: 'rank', start: 0, count: reads.count }, run.signal),
      ...reads.pointWeeks.map(week => ctx.fantasy.players(league,
        { status: 'A', position, sort: 'points', week, start: 0, count: reads.count }, run.signal)),
    ]))
    for (const player of (lists ?? []).flat()) {
      const own = basePosition(player)
      if (pool.has(player.key)) continue
      pool.set(player.key, { position: own !== undefined && reads.positions.includes(own) ? own : position, player })
    }
  }
  return [...pool.values()]
}

/**
 * Read actual league points of completed weeks through exact-player reads of at most 25 players each.
 * @param ctx - consumer context with the fantasy service.
 * @param run - research run, for cancellation.
 * @param league - league identity.
 * @param players - players whose points are read.
 * @param weeks - completed weeks.
 * @param caveats - report caveats a failed read appends to.
 * @returns points by player key and week, or undefined when a read fails; players Yahoo did not score are absent.
 */
export async function readRecentPoints(ctx: Context, run: ResearchWorkflowRun, league: LeagueKey, players: readonly FantasyPlayer[],
  weeks: readonly number[], caveats: string[]): Promise<Map<PlayerKey, Map<number, number>> | undefined> {
  const keys = [...new Set(players.map(player => player.key))]
  const batches = Array.from({ length: Math.ceil(keys.length / PLAYER_KEYS_PER_READ) },
    (_, index) => keys.slice(index * PLAYER_KEYS_PER_READ, (index + 1) * PLAYER_KEYS_PER_READ))
  const read = await attempt(run, caveats, 'Recent Yahoo points could not be read, so recent form is missing',
    () => Promise.all(weeks.flatMap(week => batches.map(async batch => ({ week,
      players: await ctx.fantasy.players(league, { playerKeys: batch, start: 0, count: batch.length, week }, run.signal) })))))
  if (read === undefined) return undefined
  const points = new Map<PlayerKey, Map<number, number>>()
  for (const { week, players: scored } of read) {
    for (const player of scored) {
      if (player.points === undefined) continue
      const byWeek = points.get(player.key) ?? new Map<number, number>()
      byWeek.set(week, player.points)
      points.set(player.key, byWeek)
    }
  }
  return points
}

/** NFL games of the report week and recent usage by player key. */
export interface NflFacts {
  readonly games: readonly FantasyNflGame[]
  readonly usage: ReadonlyMap<PlayerKey, readonly FantasyNflUsage[]>
}

/**
 * Read the report week's NFL games and recent usage from the NFL data service, when one is mounted.
 * @param ctx - consumer context; the NFL data service is optional.
 * @param run - research run, for cancellation.
 * @param season - NFL season year.
 * @param week - report week.
 * @param usage - completed weeks and players whose usage is read.
 * @param caveats - report caveats a missing service or failed read appends to.
 * @returns games and usage, or undefined when the service is absent or a read fails.
 */
export async function readNfl(ctx: Context, run: ResearchWorkflowRun, season: number, week: number,
  usage: { readonly weeks: readonly number[]; readonly players: readonly FantasyPlayer[] },
  caveats: string[]): Promise<NflFacts | undefined> {
  const nfl = ctx.get('fantasyNfl')
  if (nfl === undefined) {
    caveats.push('No NFL data service is mounted, so opponents, kickoffs, implied totals, usage, and early-kickoff deadlines are missing.')
    return undefined
  }
  return attempt(run, caveats, 'NFL games and usage could not be read, so opponents, kickoffs, implied totals, and usage are missing',
    async () => {
      const [games, used] = await Promise.all([nfl.games(season, week, run.signal), usage.weeks.length === 0
        ? new Map<PlayerKey, readonly FantasyNflUsage[]>() : nfl.usage(season, usage.weeks, usage.players, run.signal)])
      return { games, usage: used }
    })
}
