/** Yahoo v2 numbered collections and partial-object arrays projected to Fantasy views. @module @deepseek-ai/dsh-fantasy-yahoo/parse */

import { LeagueKey, PlayerKey, TeamKey } from '@deepseek-ai/dsh-fantasy'
import type {
  FantasyDraftPick, FantasyGameWeek, FantasyLeague, FantasyLeagueSettings, FantasyMatchup,
  FantasyPlayer, FantasyRoster, FantasyScoringStat, FantasyTeam, FantasyTransaction,
} from '@deepseek-ai/dsh-fantasy/types'

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function number(value: unknown): number | undefined {
  const result = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isFinite(result) ? result : undefined
}

function flag(value: unknown): boolean {
  return value === true || value === 1 || value === '1'
}

/** Merge Yahoo's array of entity fragments without flattening nested view objects. */
function fragments(value: unknown): JsonObject {
  if (Array.isArray(value)) {
    const merged: JsonObject = {}
    for (const part of value) Object.assign(merged, fragments(part))
    return merged
  }
  return object(value) ?? {}
}

function numbered(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  const row = object(value)
  if (row === undefined) return []
  return Object.keys(row).filter(key => /^(0|[1-9][0-9]*)$/u.test(key))
    .sort((a, b) => Number(a) - Number(b)).map(key => row[key])
}

function walk(value: unknown, field: string, output: unknown[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, field, output)
    return
  }
  const row = object(value)
  if (row === undefined) return
  if (row[field] !== undefined) output.push(row[field])
  for (const entry of Object.values(row)) walk(entry, field, output)
}

function found(value: unknown, field: string): unknown[] {
  const output: unknown[] = []
  walk(value, field, output)
  return output
}

function content(raw: unknown): JsonObject {
  const result = object(object(raw)?.['fantasy_content'])
  if (result === undefined) throw new Error('Yahoo Fantasy response has no fantasy_content')
  return result
}

function requiredString(value: unknown, label: string): string {
  const result = string(value)
  if (result === undefined || result === '') throw new Error(`Yahoo Fantasy response has no ${label}`)
  return result
}

function numericId(value: unknown, label: string): string {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  return requiredString(value, label)
}

function firstEntity(raw: unknown, label: 'league' | 'team' | 'player'): JsonObject {
  const value = found(content(raw), label).find((candidate) => {
    const row = fragments(candidate)
    return row[`${label}_key`] !== undefined
  })
  if (value === undefined) throw new Error(`Yahoo Fantasy response has no ${label}`)
  return fragments(value)
}

/** Parse visible leagues from an account or league response.
 * @param raw - Yahoo league or user-leagues response.
 * @returns account-visible leagues.
 */
export function parseLeagues(raw: unknown): FantasyLeague[] {
  return found(content(raw), 'league').map(fragments).filter(row => row['league_key'] !== undefined).map(row => ({
    key: LeagueKey(requiredString(row['league_key'], 'league_key')),
    name: requiredString(row['name'], 'league name'),
    ...(string(row['season']) === undefined ? {} : { season: string(row['season']) }),
    ...(number(row['current_week']) === undefined ? {} : { currentWeek: number(row['current_week']) }),
    ...(number(row['num_teams']) === undefined ? {} : { teamCount: number(row['num_teams']) }),
    ...(string(row['scoring_type']) === undefined ? {} : { scoringType: string(row['scoring_type']) }),
  }))
}

/** Parse scoring rules and roster slots.
 * @param raw - Yahoo league settings response.
 * @returns roster slots and scoring modifiers.
 */
export function parseLeagueSettings(raw: unknown): FantasyLeagueSettings {
  const league = parseLeagues(raw)[0]
  if (league === undefined) throw new Error('Yahoo Fantasy settings has no league')
  const settings = fragments(found(content(raw), 'settings')[0])
  const slots = numbered(settings['roster_positions']).map(entry => object(object(entry)?.['roster_position']))
    .filter((entry): entry is JsonObject => entry !== undefined)
    .map(entry => ({
      position: requiredString(entry['position'], 'roster position'),
      count: number(entry['count']) ?? 0,
      starting: flag(entry['is_starting_position']),
    }))
  const modifiers = new Map<string, number>()
  for (const item of numbered(object(settings['stat_modifiers'])?.['stats'])) {
    const stat = object(object(item)?.['stat'])
    const id = stat?.['stat_id'] === undefined ? undefined : numericId(stat['stat_id'], 'stat_id')
    const value = number(stat?.['value'])
    if (id !== undefined && value !== undefined) modifiers.set(id, value)
  }
  const scoring: FantasyScoringStat[] = numbered(object(settings['stat_categories'])?.['stats'])
    .map(entry => object(object(entry)?.['stat']))
    .filter((entry): entry is JsonObject => entry !== undefined)
    .map((entry) => {
      const id = numericId(entry['stat_id'], 'stat_id')
      return {
        id, name: string(entry['display_name']) ?? requiredString(entry['name'], 'stat name'),
        ...(string(entry['abbr']) === undefined ? {} : { abbreviation: string(entry['abbr']) }),
        ...(modifiers.get(id) === undefined ? {} : { value: modifiers.get(id) }),
      }
    })
  return {
    league,
    ...(string(settings['draft_type']) === undefined ? {} : { draftType: string(settings['draft_type']) }),
    ...(string(settings['waiver_type']) === undefined ? {} : { waiverType: string(settings['waiver_type']) }),
    ...(string(settings['waiver_rule']) === undefined ? {} : { waiverRule: string(settings['waiver_rule']) }),
    ...(string(settings['trade_end_date']) === undefined ? {} : { tradeEndDate: string(settings['trade_end_date']) }),
    ...(number(settings['playoff_start_week']) === undefined ? {} : { playoffStartWeek: number(settings['playoff_start_week']) }),
    rosterSlots: slots, scoring,
  }
}

function teamFrom(value: unknown): FantasyTeam {
  const row = fragments(value)
  const standings = object(row['team_standings'])
  const outcomes = object(standings?.['outcome_totals'])
  return {
    key: TeamKey(requiredString(row['team_key'], 'team_key')),
    name: requiredString(row['name'], 'team name'),
    ...(number(standings?.['rank']) === undefined ? {} : { rank: number(standings?.['rank']) }),
    ...(number(outcomes?.['wins']) === undefined ? {} : { wins: number(outcomes?.['wins']) }),
    ...(number(outcomes?.['losses']) === undefined ? {} : { losses: number(outcomes?.['losses']) }),
    ...(number(outcomes?.['ties']) === undefined ? {} : { ties: number(outcomes?.['ties']) }),
    ...(number(object(row['team_points'])?.['total']) === undefined ? {} : { points: number(object(row['team_points'])?.['total']) }),
    ...(number(object(row['team_projected_points'])?.['total']) === undefined
      ? {} : { projectedPoints: number(object(row['team_projected_points'])?.['total']) }),
    ...(number(row['win_probability']) === undefined ? {} : { winProbability: number(row['win_probability']) }),
  }
}

/** Parse the league standings.
 * @param raw - Yahoo standings response.
 * @returns ranked teams.
 */
export function parseStandings(raw: unknown): FantasyTeam[] {
  return found(content(raw), 'team').filter(value => fragments(value)['team_key'] !== undefined).map(teamFrom)
}

/** Parse weekly matchups.
 * @param raw - Yahoo scoreboard or team-matchups response.
 * @returns matchups with scores and projections.
 */
export function parseMatchups(raw: unknown): FantasyMatchup[] {
  return found(content(raw), 'matchup').map((value) => {
    const row = fragments(value)
    const teams = found(value, 'team').filter(item => fragments(item)['team_key'] !== undefined).map(teamFrom)
    const week = number(row['week'])
    if (week === undefined) throw new Error('Yahoo Fantasy matchup has no week')
    return { week, ...(string(row['status']) === undefined ? {} : { status: string(row['status']) }), teams }
  })
}

function stats(value: unknown): Record<string, number> | undefined {
  const values = numbered(object(value)?.['stats'])
  if (values.length === 0) return undefined
  const output: Record<string, number> = {}
  for (const entry of values) {
    const stat = object(object(entry)?.['stat'])
    const id = string(stat?.['stat_id'])
    const amount = number(stat?.['value'])
    if (id !== undefined && amount !== undefined) output[id] = amount
  }
  return output
}

function playerFrom(value: unknown): FantasyPlayer {
  const row = fragments(value)
  const name = object(row['name'])
  const selected = fragments(row['selected_position'])
  const owned = fragments(row['percent_owned'])
  const eligible = Array.isArray(row['eligible_positions'])
    ? row['eligible_positions'].map(entry => string(object(entry)?.['position'])).filter((part): part is string => part !== undefined)
    : []
  return {
    key: PlayerKey(requiredString(row['player_key'], 'player_key')),
    name: requiredString(name?.['full'], 'player name'),
    ...(string(row['editorial_team_abbr']) === undefined ? {} : { nflTeam: string(row['editorial_team_abbr']) }),
    positions: eligible.length > 0 ? eligible : string(row['display_position'])?.split(',') ?? [],
    ...(string(selected['position']) === undefined ? {} : { selectedSlot: string(selected['position']) }),
    ...(string(row['status']) === undefined ? {} : { status: string(row['status']) }),
    ...(string(row['injury_note']) === undefined ? {} : { injuryNote: string(row['injury_note']) }),
    ...(number(object(row['bye_weeks'])?.['week']) === undefined ? {} : { byeWeek: number(object(row['bye_weeks'])?.['week']) }),
    ...(number(object(row['player_points'])?.['total']) === undefined ? {} : { points: number(object(row['player_points'])?.['total']) }),
    ...(number(object(row['player_projected_points'])?.['total']) === undefined
      ? {} : { projectedPoints: number(object(row['player_projected_points'])?.['total']) }),
    ...(number(owned['value']) === undefined ? {} : { percentOwned: number(owned['value']) }),
    ...(number(row['rank']) === undefined ? {} : { rank: number(row['rank']) }),
    ...(string(object(row['ownership'])?.['ownership_type']) === undefined
      ? {} : { ownershipType: string(object(row['ownership'])?.['ownership_type']) }),
    ...(stats(row['player_stats']) === undefined ? {} : { stats: stats(row['player_stats']) }),
  }
}

/** Parse a league player page.
 * @param raw - Yahoo league players response.
 * @returns player page.
 */
export function parsePlayers(raw: unknown): FantasyPlayer[] {
  return found(content(raw), 'player').filter(value => fragments(value)['player_key'] !== undefined).map(playerFrom)
}

/** Parse a selected team roster.
 * @param raw - Yahoo team roster response.
 * @returns team and its player page.
 */
export function parseRoster(raw: unknown): FantasyRoster {
  const team = teamFrom(firstEntity(raw, 'team'))
  const roster = fragments(found(content(raw), 'roster')[0])
  const week = number(roster['week'])
  if (week === undefined) throw new Error('Yahoo Fantasy roster has no week')
  return { team, week, players: parsePlayers(raw) }
}

/** Parse a league transaction page.
 * @param raw - Yahoo league transactions response.
 * @returns transaction page.
 */
export function parseTransactions(raw: unknown): FantasyTransaction[] {
  return found(content(raw), 'transaction').filter(value => fragments(value)['transaction_key'] !== undefined).map((value) => {
    const row = fragments(value)
    const players = found(value, 'player').filter(item => fragments(item)['player_key'] !== undefined).map((item) => {
      const player = playerFrom(item)
      const movement = fragments(fragments(item)['transaction_data'])
      const key = string(movement['destination_team_key']) ?? string(movement['source_team_key'])
      return {
        player,
        ...(string(movement['type']) === undefined ? {} : { movement: string(movement['type']) }),
        ...(key === undefined ? {} : { teamKey: TeamKey(key) }),
      }
    })
    return {
      key: requiredString(row['transaction_key'], 'transaction_key'),
      type: requiredString(row['type'], 'transaction type'),
      ...(string(row['status']) === undefined ? {} : { status: string(row['status']) }),
      ...(number(row['timestamp']) === undefined ? {} : { timestamp: number(row['timestamp']) }),
      players,
    }
  })
}

/** Parse completed league draft picks.
 * @param raw - Yahoo draft results response.
 * @returns completed picks.
 */
export function parseDraft(raw: unknown): FantasyDraftPick[] {
  return found(content(raw), 'draft_result').map((value) => {
    const row = fragments(value)
    const pick = number(row['pick'])
    const round = number(row['round'])
    if (pick === undefined || round === undefined) throw new Error('Yahoo Fantasy draft result lacks pick or round')
    return {
      pick, round,
      teamKey: TeamKey(requiredString(row['team_key'], 'draft team_key')),
      playerKey: PlayerKey(requiredString(row['player_key'], 'draft player_key')),
    }
  })
}

/** Parse NFL game week dates.
 * @param raw - Yahoo game weeks response.
 * @returns game calendar.
 */
export function parseGameWeeks(raw: unknown): FantasyGameWeek[] {
  return found(content(raw), 'game_week').map((value) => {
    const row = fragments(value)
    const week = number(row['week'])
    if (week === undefined) throw new Error('Yahoo Fantasy game week has no week')
    return {
      week,
      start: requiredString(row['start'], 'week start'),
      end: requiredString(row['end'], 'week end'),
      ...(string(row['current']) === undefined ? {} : { currentDate: string(row['current']) }),
    }
  })
}
