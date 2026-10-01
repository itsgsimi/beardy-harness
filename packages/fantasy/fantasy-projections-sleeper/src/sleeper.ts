/**
 * Sleeper projection rows: wire validation, translation of Sleeper stat keys to Yahoo stat ids, and
 * matching of league players to rows by normalized name, NFL team, and position.
 * @module @deepseek-ai/dsh-fantasy-projections-sleeper/sleeper
 */

import type { FantasyPlayer } from '@deepseek-ai/dsh-fantasy/types'

/** One validated Sleeper projection row. */
export interface SleeperRow {
  readonly name: string
  /** Sleeper primary position, such as `WR` or `DEF`. */
  readonly position: string
  /** Primary position plus Sleeper's fantasy positions. */
  readonly positions: readonly string[]
  /** Uppercase NFL team abbreviation. */
  readonly team: string
  /** Projected stats by Sleeper stat key. */
  readonly stats: Readonly<Record<string, number>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Validate a Sleeper projections response body. Rows without a player name, position, team, or stats
 * object are skipped, and non-numeric stat values are dropped.
 * @param body - parsed JSON response.
 * @returns valid rows in response order.
 */
export function parseRows(body: unknown): SleeperRow[] {
  if (!Array.isArray(body)) throw new Error('fantasy-projections-sleeper: projection response is not an array')
  return body.flatMap((row): SleeperRow[] => {
    if (!isRecord(row) || !isRecord(row.player) || !isRecord(row.stats)) return []
    const player = row.player
    const first = text(player.first_name)
    const last = text(player.last_name)
    const position = text(player.position)
    const team = text(row.team) ?? text(player.team)
    if (first === undefined || last === undefined || position === undefined || team === undefined) return []
    const fantasy = Array.isArray(player.fantasy_positions) ? player.fantasy_positions.flatMap(item => text(item) ?? []) : []
    const stats = Object.fromEntries(Object.entries(row.stats).filter((entry): entry is [string, number] =>
      typeof entry[1] === 'number' && Number.isFinite(entry[1])))
    return [{ name: `${first} ${last}`, position: position.toUpperCase(),
      positions: [...new Set([position, ...fantasy].map(item => item.toUpperCase()))], team: team.toUpperCase(), stats }]
  })
}

/** Yahoo stat id and the Sleeper keys summed into it, for offensive players and kickers. */
const PLAYER_STATS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['4', ['pass_yd']], ['5', ['pass_td']], ['6', ['pass_int']], ['8', ['rush_att']], ['9', ['rush_yd']], ['10', ['rush_td']],
  ['11', ['rec']], ['12', ['rec_yd']], ['13', ['rec_td']], ['15', ['pr_td', 'kr_td']], ['16', ['pass_2pt', 'rush_2pt', 'rec_2pt']],
  ['18', ['fum_lost']], ['19', ['fgm_0_19']], ['20', ['fgm_20_29']], ['21', ['fgm_30_39']], ['22', ['fgm_40_49']],
  ['23', ['fgm_50p']], ['24', ['fgmiss_0_19']], ['25', ['fgmiss_20_29']], ['26', ['fgmiss_30_39']], ['27', ['fgmiss_40_49']],
  ['28', ['fgmiss_50p']], ['29', ['xpm']], ['30', ['xpmiss']], ['78', ['rec_tgt']],
]

/** Yahoo stat id and the Sleeper keys summed into it, for team defenses; return touchdowns are handled separately. */
const DEFENSE_STATS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['31', ['pts_allow']], ['32', ['sack']], ['33', ['int']], ['34', ['fum_rec']], ['35', ['def_td']], ['36', ['safe']],
  ['37', ['blk_kick']],
]

/** Points-allowed tiers: Yahoo stat id, Sleeper tier flag, and the exclusive upper bound of points allowed. */
const ALLOWED_TIERS: ReadonlyArray<readonly [string, string, number]> = [
  ['50', 'pts_allow_0', 1], ['51', 'pts_allow_1_6', 7], ['52', 'pts_allow_7_13', 14], ['53', 'pts_allow_14_20', 21],
  ['54', 'pts_allow_21_27', 28], ['55', 'pts_allow_28_34', 35], ['56', 'pts_allow_35p', Number.POSITIVE_INFINITY],
]

function sum(stats: Readonly<Record<string, number>>, keys: readonly string[]): number | undefined {
  const present = keys.filter(key => stats[key] !== undefined)
  return present.length === 0 ? undefined : present.reduce((total, key) => total + (stats[key] as number), 0)
}

/**
 * Translate a row's Sleeper stats to a Yahoo stat line. A defense row uses the defense keys, its
 * `def_pr_td` plus `def_kr_td` (or `st_td` when both are absent) as return touchdowns, and Sleeper's
 * points-allowed tier flags, or the tier containing `pts_allow` when the row has no tier flag.
 * @param row - validated row.
 * @returns projected values by Yahoo stat id; stats the row lacks are absent.
 */
export function translate(row: SleeperRow): Record<string, number> {
  const defense = row.position === 'DEF'
  const line: Record<string, number> = {}
  for (const [id, keys] of defense ? DEFENSE_STATS : PLAYER_STATS) {
    const value = sum(row.stats, keys)
    if (value !== undefined) line[id] = value
  }
  if (!defense) return line
  const returns = sum(row.stats, ['def_pr_td', 'def_kr_td']) ?? row.stats.st_td
  if (returns !== undefined) line['49'] = returns
  const flagged = ALLOWED_TIERS.filter(([, key]) => row.stats[key] !== undefined)
  for (const [id, key] of flagged) line[id] = row.stats[key] as number
  const allowed = row.stats.pts_allow
  if (flagged.length === 0 && allowed !== undefined) {
    line[(ALLOWED_TIERS.find(([, , below]) => allowed < below) as readonly [string, string, number])[0]] = 1
  }
  return line
}

/** Name suffix tokens dropped before matching. */
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v'])

/**
 * Normalize a player name for matching: ASCII letters only, lowercase, periods and apostrophes removed,
 * generational suffixes dropped, other separators collapsed to single spaces.
 * @param name - display name.
 * @returns normalized words joined by spaces.
 */
export function normalizeName(name: string): string {
  return name.normalize('NFKD').replace(/[^\x20-\x7e]/gu, '').toLowerCase().replace(/[.'`]/gu, '')
    .split(/[^a-z]+/u).filter(word => word !== '' && !SUFFIXES.has(word)).join(' ')
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key)
  if (list === undefined) map.set(key, [value])
  else list.push(value)
}

/** Rows of one projection week indexed for player matching. */
export class ProjectionIndex {
  private readonly byName = new Map<string, SleeperRow[]>()
  private readonly byLastName = new Map<string, SleeperRow[]>()
  private readonly defenses = new Map<string, SleeperRow[]>()

  /** @param rows - validated rows of one week. */
  constructor(rows: readonly SleeperRow[]) {
    for (const row of rows) {
      if (row.position === 'DEF') {
        push(this.defenses, row.team, row)
        continue
      }
      const name = normalizeName(row.name)
      push(this.byName, `${name}|${row.team}`, row)
      for (const position of row.positions) push(this.byLastName, `${name.split(' ').at(-1) as string}|${row.team}|${position}`, row)
    }
  }

  /**
   * Find a player's row: a defense by NFL team; anyone else by normalized full name and team, or else by
   * last name, team, and an eligible position when exactly one row fits.
   * @param player - league player.
   * @returns the single matching row, or undefined when none or several match.
   */
  match(player: FantasyPlayer): SleeperRow | undefined {
    if (player.nflTeam === undefined) return undefined
    const team = player.nflTeam.toUpperCase()
    const only = (rows: readonly SleeperRow[] | undefined): SleeperRow | undefined => rows?.length === 1 ? rows[0] : undefined
    if (player.positions.includes('DEF')) return only(this.defenses.get(team))
    const name = normalizeName(player.name)
    const exact = only(this.byName.get(`${name}|${team}`))
    if (exact !== undefined) return exact
    const last = name.split(' ').at(-1) as string
    return only([...new Set(player.positions.flatMap(position => this.byLastName.get(`${last}|${team}|${position.toUpperCase()}`) ?? []))])
  }
}
