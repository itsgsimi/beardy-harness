/** Read-only Fantasy views shared by providers and consumers. @module @deepseek-ai/dsh-fantasy/types */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Yahoo season-scoped league identity. */
export type LeagueKey = Branded<'LeagueKey'>
/** Yahoo league-scoped team identity. */
export type TeamKey = Branded<'TeamKey'>
/** Yahoo season-scoped player identity. */
export type PlayerKey = Branded<'PlayerKey'>

/** A league visible to the authenticated Yahoo account. */
export interface FantasyLeague {
  readonly key: LeagueKey
  readonly name: string
  readonly season?: string | undefined
  readonly currentWeek?: number | undefined
  readonly teamCount?: number | undefined
  readonly scoringType?: string | undefined
}

/** One roster slot and its allowed count. */
export interface FantasyRosterSlot {
  readonly position: string
  readonly count: number
  readonly starting: boolean
}

/** One scored category and its league multiplier. */
export interface FantasyScoringStat {
  readonly id: string
  readonly name: string
  readonly abbreviation?: string | undefined
  readonly value?: number | undefined
}

/** League options needed for lineup and waiver decisions. */
export interface FantasyLeagueSettings {
  readonly league: FantasyLeague
  readonly draftType?: string | undefined
  readonly waiverType?: string | undefined
  readonly waiverRule?: string | undefined
  readonly tradeEndDate?: string | undefined
  readonly playoffStartWeek?: number | undefined
  readonly rosterSlots: readonly FantasyRosterSlot[]
  readonly scoring: readonly FantasyScoringStat[]
}

/** A team and its score or standings facts when present. */
export interface FantasyTeam {
  readonly key: TeamKey
  readonly name: string
  readonly rank?: number | undefined
  readonly wins?: number | undefined
  readonly losses?: number | undefined
  readonly ties?: number | undefined
  readonly points?: number | undefined
  readonly projectedPoints?: number | undefined
  readonly winProbability?: number | undefined
}

/** One matchup returned by Yahoo for a requested week. */
export interface FantasyMatchup {
  readonly week: number
  readonly status?: string | undefined
  readonly teams: readonly FantasyTeam[]
}

/** Player status, ownership, and scoring fields when Yahoo supplies them. */
export interface FantasyPlayer {
  readonly key: PlayerKey
  readonly name: string
  readonly nflTeam?: string | undefined
  readonly positions: readonly string[]
  readonly selectedSlot?: string | undefined
  /**
   * Whether Yahoo refuses a slot change for this player in the roster's week, usually because his NFL
   * game has started; absent when the response does not say, as on league player pages.
   */
  readonly slotLocked?: boolean | undefined
  readonly status?: string | undefined
  readonly injuryNote?: string | undefined
  readonly byeWeek?: number | undefined
  readonly points?: number | undefined
  readonly projectedPoints?: number | undefined
  readonly percentOwned?: number | undefined
  readonly rank?: number | undefined
  readonly ownershipType?: string | undefined
  readonly stats?: Readonly<Record<string, number>> | undefined
}

/** One team roster with its requested scoring week. */
export interface FantasyRoster {
  readonly team: FantasyTeam
  readonly week: number
  readonly players: readonly FantasyPlayer[]
}

/** One add, drop, or trade movement in the league log. */
export interface FantasyTransaction {
  readonly key: string
  readonly type: string
  readonly status?: string | undefined
  readonly timestamp?: number | undefined
  readonly players: readonly { player: FantasyPlayer; movement?: string | undefined; teamKey?: TeamKey | undefined }[]
}

/** One completed draft pick. */
export interface FantasyDraftPick {
  readonly pick: number
  readonly round: number
  readonly teamKey: TeamKey
  readonly playerKey: PlayerKey
}

/** One scheduled game week. */
export interface FantasyGameWeek {
  readonly week: number
  readonly start: string
  readonly end: string
  readonly currentDate?: string | undefined
}
