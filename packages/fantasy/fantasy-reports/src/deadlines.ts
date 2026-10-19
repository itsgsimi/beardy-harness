/**
 * Report-week deadlines from the NFL schedule and league waiver settings: kickoffs before the first Sunday
 * game, the first Sunday kickoff that closes the final lineup, and when waiver claims clear.
 * @module @deepseek-ai/dsh-fantasy-reports/deadlines
 */

import type { FantasyLeagueSettings, FantasyNflGame } from '@deepseek-ai/dsh-fantasy/types'

/** Timezone the NFL publishes its schedule in; game days are Eastern calendar days. */
const NFL_TIMEZONE = 'America/New_York'

/** One game that kicks off before the first Sunday game. */
export interface EarlyGame {
  readonly away: string
  readonly home: string
  /** Kickoff in epoch milliseconds. */
  readonly kickoff: number
}

/** The report week's lineup and claim deadlines. */
export interface Deadlines {
  /** Games before the first Sunday kickoff, earliest first, such as Thursday night. */
  readonly early: readonly EarlyGame[]
  /** First Sunday kickoff in epoch milliseconds; absent when the schedule has no Sunday game. */
  readonly firstSunday?: number
  /** Days a dropped player stays on waivers, from league settings. */
  readonly waiverDays?: number
}

/**
 * The NFL game day of a kickoff: its weekday name on the Eastern calendar the schedule uses.
 * @param at - kickoff in epoch milliseconds.
 * @returns a weekday name such as `Thursday`.
 */
export function gameDay(at: number): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: NFL_TIMEZONE, weekday: 'long' }).format(at)
}

/**
 * Compute the report week's deadlines.
 * @param games - the report week's games.
 * @param settings - league settings with the waiver period.
 * @returns early games, the first Sunday kickoff, and the waiver period.
 */
export function weekDeadlines(games: readonly FantasyNflGame[], settings: FantasyLeagueSettings): Deadlines {
  const kicks = games.map(game => ({ away: game.away.toUpperCase(), home: game.home.toUpperCase(), kickoff: Date.parse(game.kickoff) }))
    .sort((a, b) => a.kickoff - b.kickoff)
  const firstSunday = kicks.find(game => gameDay(game.kickoff) === 'Sunday')?.kickoff
  return {
    early: firstSunday === undefined ? [] : kicks.filter(game => game.kickoff < firstSunday),
    ...(firstSunday === undefined ? {} : { firstSunday }),
    ...(settings.waiverDays === undefined ? {} : { waiverDays: settings.waiverDays }),
  }
}

/**
 * The claim deadline sentence of the checklist.
 * @param deadlines - report-week deadlines.
 * @returns when to submit claims, with the league's waiver period when Yahoo states it.
 */
export function claimTiming(deadlines: Deadlines): string {
  const days = deadlines.waiverDays === undefined ? '' : `; dropped players stay on waivers for ${deadlines.waiverDays} `
    + `day${deadlines.waiverDays === 1 ? '' : 's'}`
  return `submit now, before Yahoo processes claims${days}`
}
