/** Read-only Fantasy and projection service definitions. @module @deepseek-ai/dsh-fantasy */

import { Context, Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Session } from '@deepseek-ai/dsh-session'
import type {
  FantasyDraftPick, FantasyGameWeek, FantasyLeague, FantasyLeagueSettings, FantasyMatchup,
  FantasyPlayer, FantasyRoster, FantasyScoringStat, FantasyTeam, FantasyTransaction, LeagueKey as LeagueKeyType,
  PlayerKey as PlayerKeyType, TeamKey as TeamKeyType,
} from './types.ts'

export type * from './types.ts'

/** Validate a Yahoo league key before using it in a request path.
 * @param value - untrusted key.
 * @returns branded key.
 */
export function LeagueKey(value: string): LeagueKeyType {
  if (!/^[0-9]+\.l\.[0-9]+$/u.test(value)) throw new Error('invalid fantasy league key')
  return brandString<LeagueKeyType>(value)
}

/** Validate a Yahoo team key before using it in a request path.
 * @param value - untrusted key.
 * @returns branded key.
 */
export function TeamKey(value: string): TeamKeyType {
  if (!/^[0-9]+\.l\.[0-9]+\.t\.[0-9]+$/u.test(value)) throw new Error('invalid fantasy team key')
  return brandString<TeamKeyType>(value)
}

/** Validate a Yahoo player key before using it in a request path.
 * @param value - untrusted key.
 * @returns branded key.
 */
export function PlayerKey(value: string): PlayerKeyType {
  if (!/^[0-9]+\.p\.[0-9]+$/u.test(value)) throw new Error('invalid fantasy player key')
  return brandString<PlayerKeyType>(value)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    fantasy: FantasyService
    fantasyProjections: FantasyProjectionService
  }
}

/** Provider-neutral read operations; callers supply explicit league or team identities. */
export abstract class FantasyService extends Service {
  constructor(ctx: Context) {
    if (new.target === FantasyService) throw new Error('load a fantasy provider, not the abstract definition')
    super(ctx, 'fantasy')
  }

  /** Resolve the caller's own team from its trusted Session preset.
   * @param caller - trusted live caller Session.
   * @returns configured team for its preset, or an error when unmapped.
   */
  abstract teamFor(caller: Session): TeamKeyType

  /** List leagues visible to the authenticated account.
   * @param signal - caller cancellation.
   * @returns authenticated account leagues.
   */
  abstract leagues(signal?: AbortSignal): Promise<readonly FantasyLeague[]>
  /** Read scoring settings and roster slots for a league.
   * @param key - league identity.
   * @param signal - caller cancellation.
   * @returns league options and scoring.
   */
  abstract league(key: LeagueKeyType, signal?: AbortSignal): Promise<FantasyLeagueSettings>
  /** Read the current league standings.
   * @param key - league identity.
   * @param signal - caller cancellation.
   * @returns season standings.
   */
  abstract standings(key: LeagueKeyType, signal?: AbortSignal): Promise<readonly FantasyTeam[]>
  /** Read every matchup on a league scoreboard.
   * @param key - league identity.
   * @param week - optional scoring week.
   * @param signal - caller cancellation.
   * @returns weekly matchups.
   */
  abstract scoreboard(key: LeagueKeyType, week?: number, signal?: AbortSignal): Promise<readonly FantasyMatchup[]>
  /** Read matchups involving one team.
   * @param key - team identity.
   * @param week - optional scoring week.
   * @param signal - caller cancellation.
   * @returns the team's matchup in `week` when given, otherwise every scheduled matchup of the season.
   */
  abstract matchups(key: TeamKeyType, week?: number, signal?: AbortSignal): Promise<readonly FantasyMatchup[]>
  /** Read selected slots and player scores on a weekly roster.
   * @param key - team identity.
   * @param week - scoring week.
   * @param signal - caller cancellation.
   * @returns roster and player scores.
   */
  abstract team(key: TeamKeyType, week: number, signal?: AbortSignal): Promise<FantasyRoster>
  /** Search or filter one page of league players.
   * @param league - league identity.
   * @param query - search or availability filters.
   * @param signal - caller cancellation.
   * @returns one provider page.
   */
  abstract players(league: LeagueKeyType, query: {
    search?: string
    status?: 'FA' | 'W'
    position?: string
    sort?: 'points' | 'rank' | 'percent_owned'
    start: number
    count: number
    week?: number
  }, signal?: AbortSignal): Promise<readonly FantasyPlayer[]>
  /** Read a player's statistics and ownership in a league.
   * @param league - league identity.
   * @param key - player identity.
   * @param week - optional scoring week.
   * @param signal - caller cancellation.
   * @returns player details.
   */
  abstract player(league: LeagueKeyType, key: PlayerKeyType, week?: number, signal?: AbortSignal): Promise<FantasyPlayer>
  /** Read one page of league transactions.
   * @param key - league identity.
   * @param start - zero-based provider offset.
   * @param count - provider page size.
   * @param signal - caller cancellation.
   * @returns recent transactions.
   */
  abstract transactions(key: LeagueKeyType, start: number, count: number, signal?: AbortSignal): Promise<readonly FantasyTransaction[]>
  /** Read the league draft results.
   * @param key - league identity.
   * @param signal - caller cancellation.
   * @returns completed draft picks.
   */
  abstract draft(key: LeagueKeyType, signal?: AbortSignal): Promise<readonly FantasyDraftPick[]>
  /** Read NFL game week dates for the configured season.
   * @param signal - caller cancellation.
   * @returns game calendar.
   */
  abstract gameWeeks(signal?: AbortSignal): Promise<readonly FantasyGameWeek[]>
}

/**
 * Weekly projected stat lines for league players from a source other than the league provider. Lines use
 * the stat ids of {@link FantasyScoringStat.id} and `FantasyPlayer.stats`, so league scoring applies to
 * them unchanged through {@link scoreStats}.
 */
export abstract class FantasyProjectionService extends Service {
  constructor(ctx: Context) {
    if (new.target === FantasyProjectionService) throw new Error('load a fantasy projection provider, not the abstract definition')
    super(ctx, 'fantasyProjections')
  }

  /** Project one NFL week's stat lines for the given players.
   * @param season - NFL season year.
   * @param week - NFL regular-season week.
   * @param players - league players to project; the provider matches them by name, NFL team, and position.
   * @param signal - caller cancellation.
   * @returns projected stat lines by player key; players the provider cannot match are absent.
   */
  abstract project(
    season: number, week: number, players: readonly FantasyPlayer[], signal?: AbortSignal,
  ): Promise<ReadonlyMap<PlayerKeyType, Readonly<Record<string, number>>>>
}

/**
 * Score a stat line under league scoring: the sum of each stat times its value, over the scoring entries
 * that carry a value; stats without a scoring entry or value count zero.
 * @param stats - stat values by stat id.
 * @param scoring - league scoring entries.
 * @returns points rounded to hundredths.
 */
export function scoreStats(stats: Readonly<Record<string, number>>, scoring: readonly FantasyScoringStat[]): number {
  const total = scoring.reduce((sum, entry) => sum + (entry.value === undefined ? 0 : (stats[entry.id] ?? 0) * entry.value), 0)
  return Math.round(total * 100) / 100
}

export default FantasyService
