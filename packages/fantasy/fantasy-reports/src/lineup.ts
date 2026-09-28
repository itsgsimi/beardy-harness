/** Lineup legality against the league's live Yahoo roster slots. @module @deepseek-ai/dsh-fantasy-reports/lineup */

import type { FantasyPlayer, FantasyRosterSlot } from '@deepseek-ai/dsh-fantasy/types'

/** One proposed starter. */
export interface LineupAssignment {
  /** Short roster id shown to the model, such as `P3`. */
  readonly player: string
  /** Yahoo starting slot, such as `QB` or `W/R/T`. */
  readonly slot: string
}

/** Yahoo flex slots and the base positions each accepts when a player's positions omit the flex slot itself. */
const FLEX_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  'W/R/T': ['WR', 'RB', 'TE'], 'W/R': ['WR', 'RB'], 'W/T': ['WR', 'TE'], 'R/T': ['RB', 'TE'],
  'Q/W/R/T': ['QB', 'WR', 'RB', 'TE'],
}

/** Yahoo statuses under which a player cannot score this week. */
const UNAVAILABLE_STATUSES = new Set(['O', 'IR', 'IR-R', 'IR-NR', 'PUP-P', 'PUP-R', 'NFI-P', 'NFI-R', 'SUSP', 'NA'])

/**
 * Whether Yahoo lists a player as unable to play this week.
 * @param player - roster player.
 * @param week - report week.
 * @returns a reason, or undefined when Yahoo shows no block.
 */
export function unavailableReason(player: FantasyPlayer, week: number): string | undefined {
  if (player.byeWeek === week) return `${player.name} is on bye in week ${week}`
  if (player.status !== undefined && UNAVAILABLE_STATUSES.has(player.status.toUpperCase())) {
    return `${player.name} has Yahoo status ${player.status}`
  }
  return undefined
}

/**
 * Whether a player may fill a slot under Yahoo eligibility.
 * @param player - roster player with Yahoo eligible positions.
 * @param slot - uppercase slot name.
 * @returns true when Yahoo lists the slot, or a flex slot accepts one of the player's positions.
 */
export function eligibleFor(player: FantasyPlayer, slot: string): boolean {
  const positions = player.positions.map(position => position.toUpperCase())
  return positions.includes(slot) || (FLEX_MEMBERS[slot]?.some(position => positions.includes(position)) ?? false)
}

/**
 * Check a proposed lineup against Yahoo's starting slots, eligibility, weekly availability, and slot locks.
 * A player whose slot Yahoo has locked stays where Yahoo shows him: a locked starter keeps his current
 * starting slot, exempt from the availability check, and a locked reserve player cannot start.
 * @param assignments - proposed starters.
 * @param players - roster players by short id.
 * @param slots - league roster slots from Yahoo settings.
 * @param week - report week, for bye and status checks.
 * @returns concrete errors; an empty list is a legal, complete lineup.
 */
export function lineupErrors(assignments: readonly LineupAssignment[], players: ReadonlyMap<string, FantasyPlayer>,
  slots: readonly FantasyRosterSlot[], week: number): string[] {
  const starting = new Map<string, number>()
  for (const slot of slots) {
    if (slot.starting) starting.set(slot.position.toUpperCase(), (starting.get(slot.position.toUpperCase()) ?? 0) + slot.count)
  }
  if (starting.size === 0) return ['Yahoo returned no starting slots for this league']
  const errors: string[] = []
  const counts = new Map<string, number>()
  const seen = new Set<string>()
  for (const assignment of assignments) {
    const slot = assignment.slot.toUpperCase()
    const player = players.get(assignment.player)
    if (seen.has(assignment.player)) errors.push(`lineup: ${assignment.player} starts more than once`)
    seen.add(assignment.player)
    if (!starting.has(slot)) {
      errors.push(`lineup: ${slot} is not a starting slot in this league`)
      continue
    }
    counts.set(slot, (counts.get(slot) ?? 0) + 1)
    if (player === undefined) {
      errors.push(`lineup: ${assignment.player} is not on the roster`)
      continue
    }
    if (!eligibleFor(player, slot)) errors.push(`lineup: ${assignment.player} (${player.name}) is not eligible for ${slot}`)
    const unavailable = player.slotLocked === true ? undefined : unavailableReason(player, week)
    if (unavailable !== undefined) errors.push(`lineup: ${assignment.player} cannot start because ${unavailable}`)
  }
  for (const [id, player] of players) {
    if (player.slotLocked !== true) continue
    const current = (player.selectedSlot ?? 'BN').toUpperCase()
    const assigned = assignments.filter(assignment => assignment.player === id).map(assignment => assignment.slot.toUpperCase())
    if (starting.has(current)) {
      if (!assigned.includes(current)) {
        errors.push(`lineup: ${id} (${player.name}) is locked in ${current} by Yahoo because his game has started; keep him in ${current}`)
      }
    } else if (assigned.length > 0) {
      errors.push(`lineup: ${id} (${player.name}) is locked on ${current} by Yahoo because his game has started; he cannot start`)
    }
  }
  for (const [slot, count] of starting) {
    const actual = counts.get(slot) ?? 0
    if (actual !== count) errors.push(`lineup: ${slot} needs ${count} starter(s); the draft has ${actual}`)
  }
  return errors
}

/**
 * Compare a recommended lineup with the slots Yahoo currently shows.
 * @param assignments - recommended starters.
 * @param players - roster players by short id.
 * @param slots - league roster slots from Yahoo settings.
 * @returns players to move into and out of the starting lineup.
 */
export function lineupChanges(assignments: readonly LineupAssignment[], players: ReadonlyMap<string, FantasyPlayer>,
  slots: readonly FantasyRosterSlot[]): { start: FantasyPlayer[]; bench: FantasyPlayer[] } {
  const starting = new Set(slots.filter(slot => slot.starting).map(slot => slot.position.toUpperCase()))
  const recommended = new Set(assignments.map(assignment => assignment.player))
  const current = new Set([...players].filter(([, player]) => starting.has((player.selectedSlot ?? '').toUpperCase()))
    .map(([id]) => id))
  return {
    start: [...recommended].filter(id => !current.has(id)).flatMap(id => players.get(id) ?? []),
    bench: [...current].filter(id => !recommended.has(id)).map(id => players.get(id) as FantasyPlayer),
  }
}

/**
 * Roster players whose slots Yahoo has locked for the week.
 * @param players - roster players by short id.
 * @returns locked players in roster order.
 */
export function lockedPlayers(players: ReadonlyMap<string, FantasyPlayer>): FantasyPlayer[] {
  return [...players.values()].filter(player => player.slotLocked === true)
}
