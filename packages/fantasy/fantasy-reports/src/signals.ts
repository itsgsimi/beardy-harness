/**
 * Code-owned player signals beside projections: recent league points and a form flag, the week's NFL game
 * with its implied team total, and how many waiver articles name each available player.
 * @module @deepseek-ai/dsh-fantasy-reports/signals
 */

import { normalizePlayerName } from '@deepseek-ai/dsh-fantasy'
import type { FantasyNflGame, FantasyPlayer } from '@deepseek-ai/dsh-fantasy/types'

/** One player's recent actual league points and how they compare with his projection. */
export interface RecentForm {
  /** Actual points per completed week, oldest first; weeks without a score or on bye are absent. */
  readonly points: ReadonlyArray<{ readonly week: number; readonly points: number }>
  /** Average of `points`, rounded to one decimal; absent when no week scored. */
  readonly average?: number
  /** `hot` or `cold` when the average beats or trails the projection by at least the gap. */
  readonly flag?: 'hot' | 'cold'
}

/**
 * Recent form from actual league points.
 * @param player - player with his report-week projection and bye week.
 * @param weekly - actual points by completed week; a missing week has no score.
 * @param gap - points the average must beat or trail the projection by to flag form.
 * @returns the points shown, their average, and the flag.
 */
export function recentForm(player: FantasyPlayer, weekly: ReadonlyMap<number, number>, gap: number): RecentForm {
  const points = [...weekly].filter(([week]) => week !== player.byeWeek).sort(([a], [b]) => a - b)
    .map(([week, value]) => ({ week, points: value }))
  if (points.length === 0) return { points }
  const average = Math.round(points.reduce((sum, item) => sum + item.points, 0) / points.length * 10) / 10
  const projection = player.projectedPoints
  const flag = projection === undefined ? undefined : average - projection >= gap ? 'hot' as const
    : projection - average >= gap ? 'cold' as const : undefined
  return { points, average, ...(flag === undefined ? {} : { flag }) }
}

/** A player's NFL game in one week as the report states it. */
export interface GameFacts {
  /** Opponent abbreviation. */
  readonly opponent: string
  readonly home: boolean
  /** Kickoff in epoch milliseconds. */
  readonly kickoff: number
  /** Points the betting line implies for the player's team, rounded to one decimal, when the line is published. */
  readonly impliedTotal?: number
}

/**
 * Find a team's game in one week's schedule, matching abbreviations case-insensitively.
 * @param games - the week's games.
 * @param team - Yahoo NFL team abbreviation.
 * @returns opponent, side, kickoff, and implied total, or undefined when the team has no game.
 */
export function gameFor(games: readonly FantasyNflGame[], team: string | undefined): GameFacts | undefined {
  if (team === undefined) return undefined
  const code = team.toUpperCase()
  const game = games.find(item => item.home.toUpperCase() === code || item.away.toUpperCase() === code)
  if (game === undefined) return undefined
  const home = game.home.toUpperCase() === code
  const implied = game.total === undefined || game.homeSpread === undefined ? undefined
    : Math.round((game.total + (home ? game.homeSpread : -game.homeSpread)) / 2 * 10) / 10
  return { opponent: (home ? game.away : game.home).toUpperCase(), home, kickoff: Date.parse(game.kickoff),
    ...(implied === undefined ? {} : { impliedTotal: implied }) }
}

/**
 * Count the distinct pages that name each player, matching normalized names on word boundaries.
 * @param pages - page texts.
 * @param players - players to count.
 * @returns page counts by player key, for players named at least once.
 */
export function articleMentions(pages: readonly string[], players: readonly FantasyPlayer[]): Map<FantasyPlayer['key'], number> {
  const texts = pages.map(text => ` ${normalizePlayerName(text)} `)
  const counts = new Map<FantasyPlayer['key'], number>()
  for (const player of players) {
    const name = normalizePlayerName(player.name)
    if (name === '' || counts.has(player.key)) continue
    const count = texts.filter(text => text.includes(` ${name} `)).length
    if (count > 0) counts.set(player.key, count)
  }
  return counts
}
