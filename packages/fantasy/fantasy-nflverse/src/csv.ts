/**
 * nflverse CSV files: column validation, regular-season row extraction, US Eastern kickoff conversion, and
 * matching of league players to weekly stat and snap rows.
 * @module @deepseek-ai/dsh-fantasy-nflverse/csv
 */

import Papa from 'papaparse'
import { normalizePlayerName } from '@deepseek-ai/dsh-fantasy'
import type { FantasyNflGame, FantasyPlayer } from '@deepseek-ai/dsh-fantasy/types'

/** The nflverse file a table came from; it names the file in errors. */
export type TableKind = 'schedule' | 'stats' | 'snaps'

/** Columns each file must carry; a file without one fails its request. */
const COLUMNS: Readonly<Record<TableKind, readonly string[]>> = {
  schedule: ['season', 'game_type', 'week', 'gameday', 'gametime', 'away_team', 'home_team', 'spread_line', 'total_line', 'roof'],
  stats: ['player_display_name', 'position', 'team', 'opponent_team', 'week', 'season_type', 'targets', 'target_share',
    'receptions', 'carries'],
  snaps: ['player', 'position', 'team', 'opponent', 'week', 'game_type', 'offense_pct'],
}

/** One parsed CSV row keyed by column name; cells past a short row's end are undefined. */
export type CsvRow = Readonly<Record<string, string | undefined>>

/**
 * Parse one nflverse CSV body with a header row. Blank lines are skipped, and missing trailing cells read as blank.
 * @param kind - file the body came from.
 * @param body - CSV text.
 * @returns rows keyed by column name.
 */
export function parseTable(kind: TableKind, body: string): CsvRow[] {
  const parsed = Papa.parse<CsvRow>(body, { header: true, skipEmptyLines: 'greedy' })
  const fields = new Set(parsed.meta.fields)
  const missing = COLUMNS[kind].find(column => !fields.has(column))
  if (missing !== undefined) throw new Error(`fantasy-nflverse: ${kind} CSV lacks column ${missing}`)
  return parsed.data
}

function cell(row: CsvRow, column: string): string | undefined {
  const value = row[column]?.trim()
  return value === undefined || value === '' ? undefined : value
}

function number(row: CsvRow, column: string): number | undefined {
  const value = cell(row, column)
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Convert an nflverse team abbreviation to Yahoo's form: uppercase, with the Rams' `LA` written `LAR`.
 * @param team - nflverse abbreviation.
 * @returns Yahoo-form abbreviation.
 */
export function yahooTeam(team: string): string {
  const upper = team.toUpperCase()
  return upper === 'LA' ? 'LAR' : upper
}

/** nflverse writes schedule times as US Eastern wall-clock times. */
const EASTERN = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
})

/** Milliseconds US Eastern wall-clock time is ahead of UTC at one instant. */
function easternOffset(instant: number): number {
  const parts = new Map(EASTERN.formatToParts(instant).map(part => [part.type, part.value]))
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.get(type))
  const wall = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'))
  return wall - instant
}

/**
 * Convert a US Eastern date and wall-clock time to an ISO 8601 UTC timestamp, applying the daylight-saving
 * offset in effect on that date.
 * @param day - `YYYY-MM-DD`.
 * @param time - `HH:MM` on a 24-hour clock.
 * @returns the UTC timestamp, or undefined when either value is malformed.
 */
export function easternKickoff(day: string, time: string): string | undefined {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(day)
  const clock = /^(\d{2}):(\d{2})$/u.exec(time)
  if (date === null || clock === null) return undefined
  const wall = Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]), Number(clock[1]), Number(clock[2]))
  const guess = wall - easternOffset(wall)
  return new Date(wall - easternOffset(guess)).toISOString()
}

/** One schedule game with its season. */
export interface SeasonGame {
  readonly season: number
  readonly game: FantasyNflGame
}

/**
 * Extract regular-season games from schedule rows. Rows without a season, week, teams, or a valid kickoff are
 * skipped; blank lines and spreads become absent fields.
 * @param rows - parsed schedule rows.
 * @returns games in file order.
 */
export function scheduleGames(rows: readonly CsvRow[]): SeasonGame[] {
  return rows.flatMap((row): SeasonGame[] => {
    const season = number(row, 'season')
    const week = number(row, 'week')
    const home = cell(row, 'home_team')
    const away = cell(row, 'away_team')
    const kickoff = easternKickoff(cell(row, 'gameday') ?? '', cell(row, 'gametime') ?? '')
    if (cell(row, 'game_type') !== 'REG' || season === undefined || week === undefined || home === undefined
      || away === undefined || kickoff === undefined) return []
    const game: FantasyNflGame = { week, kickoff, home: yahooTeam(home), away: yahooTeam(away) }
    const homeSpread = number(row, 'spread_line')
    const total = number(row, 'total_line')
    const roof = cell(row, 'roof')
    return [{ season, game: { ...game, ...homeSpread === undefined ? {} : { homeSpread },
      ...total === undefined ? {} : { total }, ...roof === undefined ? {} : { roof } } }]
  })
}

/** One player's regular-season row of one week: stats or snaps, by the table it came from. */
export interface WeekRow {
  readonly week: number
  readonly position: string
  /** Yahoo-form team abbreviation. */
  readonly team: string
  readonly opponent?: string | undefined
  /** Numeric cells of the row by output field. */
  readonly values: Readonly<Record<string, number>>
}

/** Output field and source column of each usage value, by table. */
const VALUES: Readonly<Record<'stats' | 'snaps', ReadonlyArray<readonly [string, string]>>> = {
  stats: [['targets', 'targets'], ['targetShare', 'target_share'], ['receptions', 'receptions'], ['carries', 'carries']],
  snaps: [['snapShare', 'offense_pct']],
}

/** Name, opponent, and season-type columns of each usage table. */
const IDENTITY = {
  stats: { name: 'player_display_name', opponent: 'opponent_team', type: 'season_type' },
  snaps: { name: 'player', opponent: 'opponent', type: 'game_type' },
} as const

/** Regular-season rows of one usage table indexed by week and normalized player name. */
export class UsageIndex {
  private readonly rows = new Map<string, WeekRow[]>()

  /**
   * @param kind - `stats` or `snaps`.
   * @param rows - parsed rows; rows of other season types or without a name, position, team, or week are skipped.
   */
  constructor(kind: 'stats' | 'snaps', rows: readonly CsvRow[]) {
    const identity = IDENTITY[kind]
    for (const row of rows) {
      const name = cell(row, identity.name)
      const position = cell(row, 'position')
      const team = cell(row, 'team')
      const week = number(row, 'week')
      if (cell(row, identity.type) !== 'REG' || name === undefined || position === undefined || team === undefined
        || week === undefined) continue
      const values: Record<string, number> = {}
      for (const [field, column] of VALUES[kind]) {
        const value = number(row, column)
        if (value !== undefined) values[field] = value
      }
      const opponent = cell(row, identity.opponent)
      const entry: WeekRow = { week, position: position.toUpperCase(), team: yahooTeam(team),
        ...opponent === undefined ? {} : { opponent: yahooTeam(opponent) }, values }
      const key = `${week}|${normalizePlayerName(name)}`
      const list = this.rows.get(key)
      if (list === undefined) this.rows.set(key, [entry])
      else list.push(entry)
    }
  }

  /**
   * Find a player's row of one week: the single row with his normalized name, one of his positions, and his
   * NFL team; when no row has his team, the single row with his name and one of his positions, as after a trade.
   * @param player - league player.
   * @param week - regular-season week.
   * @returns the matching row, or undefined when none or several match.
   */
  match(player: FantasyPlayer, week: number): WeekRow | undefined {
    const positions = new Set(player.positions.map(position => position.toUpperCase()))
    const fits = (this.rows.get(`${week}|${normalizePlayerName(player.name)}`) ?? []).filter(row => positions.has(row.position))
    const team = player.nflTeam?.toUpperCase()
    const exact = fits.filter(row => row.team === team)
    const pool = exact.length > 0 ? exact : fits
    return pool.length === 1 ? pool[0] : undefined
  }
}
