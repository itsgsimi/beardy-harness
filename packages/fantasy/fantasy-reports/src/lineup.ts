/** Legal projection-maximizing lineups against the league's live Yahoo roster slots. @module @deepseek-ai/dsh-fantasy-reports/lineup */

import type { FantasyPlayer, FantasyRosterSlot } from '@deepseek-ai/dsh-fantasy/types'

/** One starting slot instance and the roster id filling it; an empty slot has no eligible available player. */
export interface LineupAssignment {
  /** Yahoo starting slot, such as `QB` or `W/R/T`. */
  readonly slot: string
  /** Short roster id, such as `P3`, or undefined for an empty slot. */
  readonly player: string | undefined
}

/** Yahoo flex slots and the base positions each accepts when a player's positions omit the flex slot itself. */
const FLEX_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  'W/R/T': ['WR', 'RB', 'TE'], 'W/R': ['WR', 'RB'], 'W/T': ['WR', 'TE'], 'R/T': ['RB', 'TE'],
  'Q/W/R/T': ['QB', 'WR', 'RB', 'TE'],
}

/** Yahoo statuses under which a player cannot score this week. */
const UNAVAILABLE_STATUSES = new Set(['O', 'IR', 'IR-R', 'IR-NR', 'PUP-P', 'PUP-R', 'NFI-P', 'NFI-R', 'SUSP', 'NA'])

/** Yahoo statuses that leave a player's availability uncertain. */
const UNCERTAIN_STATUSES = new Set(['Q', 'D', 'GTD'])

/**
 * Whether a slot is a Yahoo flex slot.
 * @param slot - uppercase slot name.
 * @returns true for a slot that accepts several base positions.
 */
export function isFlex(slot: string): boolean {
  return FLEX_MEMBERS[slot] !== undefined
}

/**
 * Whether Yahoo lists a player as unable to play this week.
 * @param player - roster player.
 * @param week - report week.
 * @returns a reason, or undefined when Yahoo shows no block.
 */
export function unavailableReason(player: FantasyPlayer, week: number): string | undefined {
  if (player.byeWeek === week) return `on bye in week ${week}`
  if (player.status !== undefined && UNAVAILABLE_STATUSES.has(player.status.toUpperCase())) return `Yahoo status ${player.status}`
  return undefined
}

/**
 * Whether Yahoo lists a player as questionable, doubtful, or a game-time decision.
 * @param player - roster player.
 * @returns true for an uncertain Yahoo status.
 */
export function uncertain(player: FantasyPlayer): boolean {
  return player.status !== undefined && UNCERTAIN_STATUSES.has(player.status.toUpperCase())
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
 * Expand the league's starting slots into one entry per instance, in Yahoo order.
 * @param slots - league roster slots from Yahoo settings.
 * @returns uppercase slot names, repeated by count.
 */
export function startingSlots(slots: readonly FantasyRosterSlot[]): string[] {
  return slots.filter(slot => slot.starting).flatMap(slot => Array.from({ length: slot.count }, () => slot.position.toUpperCase()))
}

/**
 * Whether Yahoo currently shows a player in a starting slot.
 * @param player - roster player.
 * @param starting - starting slot names.
 * @returns true for a current starter.
 */
export function startsNow(player: FantasyPlayer, starting: readonly string[]): boolean {
  return starting.includes((player.selectedSlot ?? 'BN').toUpperCase())
}

/** Search score compared in order: filled slots, projected hundredths, current starters kept, slots kept. */
type Score = readonly [number, number, number, number]

function better(a: Score, b: Score): boolean {
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return (a[index] as number) > (b[index] as number)
  return false
}

function hundredths(player: FantasyPlayer): number {
  return Math.round((player.projectedPoints ?? 0) * 100)
}

/**
 * Choose the legal lineup with the most filled slots and the highest summed Yahoo projection. A missing
 * projection counts as zero; ties keep current Yahoo starters, then their current slots, then roster
 * order. Locked starters stay in their current slot, locked reserves stay out, and players Yahoo lists
 * as unable to play never start unless locked in. A pool restricts who may start.
 * @param players - roster players by short id, in roster order.
 * @param slots - league roster slots from Yahoo settings.
 * @param week - report week, for bye and status checks.
 * @param pool - ids allowed to start besides locked starters; every available roster player when absent.
 * @returns one assignment per starting slot instance, in Yahoo slot order.
 */
export function optimizeLineup(players: ReadonlyMap<string, FantasyPlayer>, slots: readonly FantasyRosterSlot[], week: number,
  pool?: ReadonlySet<string>): LineupAssignment[] {
  const starting = startingSlots(slots)
  const fixed: Array<string | undefined> = starting.map(() => undefined)
  for (const [id, player] of players) {
    if (player.slotLocked !== true) continue
    const index = starting.findIndex((slot, at) => slot === (player.selectedSlot ?? 'BN').toUpperCase() && fixed[at] === undefined)
    if (index >= 0) fixed[index] = id
  }
  const candidates = [...players].filter(([id, player]) => player.slotLocked !== true && (pool === undefined || pool.has(id))
    && unavailableReason(player, week) === undefined)
    .sort(([, a], [, b]) => hundredths(b) - hundredths(a) || Number(startsNow(b, starting)) - Number(startsNow(a, starting)))
  const open = starting.map((slot, index) => ({ slot, index })).filter(({ index }) => fixed[index] === undefined)
    .sort((a, b) => (FLEX_MEMBERS[a.slot]?.length ?? 0) - (FLEX_MEMBERS[b.slot]?.length ?? 0))
  const options = open.map(({ slot }) => candidates.filter(([, player]) => eligibleFor(player, slot)))
  const ceiling = options.map(list => Math.max(0, ...list.map(([, player]) => hundredths(player))))
  const remaining = ceiling.map((_, at) => ceiling.slice(at).reduce((sum, value) => sum + value, 0))
  const chosen: Array<string | undefined> = open.map(() => undefined)
  const used = new Set<string>()
  const search: { best?: { readonly score: Score; readonly picks: Array<string | undefined> } } = {}
  const visit = (at: number, score: Score): void => {
    if (at === open.length) {
      if (search.best === undefined || better(score, search.best.score)) search.best = { score, picks: [...chosen] }
      return
    }
    const left = open.length - at
    if (search.best !== undefined
      && !better([score[0] + left, score[1] + (remaining[at] as number), score[2] + left, score[3] + left], search.best.score)) return
    const slot = (open[at] as { slot: string }).slot
    for (const [id, player] of options[at] as Array<[string, FantasyPlayer]>) {
      if (used.has(id)) continue
      used.add(id)
      chosen[at] = id
      visit(at + 1, [score[0] + 1, score[1] + hundredths(player), score[2] + Number(startsNow(player, starting)),
        score[3] + Number((player.selectedSlot ?? '').toUpperCase() === slot)])
      used.delete(id)
    }
    chosen[at] = undefined
    visit(at + 1, score)
  }
  visit(0, [0, 0, 0, 0])
  const picks = (search.best as { readonly picks: Array<string | undefined> }).picks
  open.forEach(({ index }, at) => { fixed[index] = picks[at] })
  return starting.map((slot, index) => ({ slot, player: fixed[index] }))
}

/**
 * Compare a lineup with the slots Yahoo currently shows.
 * @param assignments - recommended starters.
 * @param players - roster players by short id.
 * @param slots - league roster slots from Yahoo settings.
 * @returns ids to move into and out of the starting lineup, in roster order.
 */
export function lineupChanges(assignments: readonly LineupAssignment[], players: ReadonlyMap<string, FantasyPlayer>,
  slots: readonly FantasyRosterSlot[]): { start: string[]; bench: string[] } {
  const starting = startingSlots(slots)
  const recommended = new Set(assignments.flatMap(assignment => assignment.player ?? []))
  const ids = [...players.keys()]
  return {
    start: ids.filter(id => recommended.has(id) && !startsNow(players.get(id) as FantasyPlayer, starting)),
    bench: ids.filter(id => !recommended.has(id) && startsNow(players.get(id) as FantasyPlayer, starting)),
  }
}
