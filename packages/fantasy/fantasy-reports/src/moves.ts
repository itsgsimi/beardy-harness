/**
 * Code-owned roster moves over the report horizon: IR moves and open roster room, per-week roster views,
 * the bye outlook, the marginal value of adding an available player with its cheapest drop, drop costs,
 * and the surplus trade chip. Every function is deterministic over Yahoo data and projections.
 * @module @deepseek-ai/dsh-fantasy-reports/moves
 */

import type { FantasyPlayer, FantasyRosterSlot } from '@deepseek-ai/dsh-fantasy/types'
import { isFlex, optimizeLineup, slotAccepts, startingSlots, unavailableReason } from './lineup.ts'

/** Slot and eligibility name of injured reserve in Yahoo settings and player positions. */
const IR = 'IR'

/** Yahoo statuses that describe more than the next game, so they still apply to later horizon weeks. */
const LASTING_STATUSES = new Set(['IR', 'IR-R', 'IR-NR', 'PUP-P', 'PUP-R', 'NFI-P', 'NFI-R', 'SUSP', 'NA'])

/**
 * Whether Yahoo shows a player in an injured-reserve slot.
 * @param player - roster player.
 * @returns true for a player whose selected slot is IR.
 */
export function inIr(player: FantasyPlayer): boolean {
  return (player.selectedSlot ?? '').toUpperCase() === IR
}

/** IR moves code suggests and the active-roster spots open after them. */
export interface RosterRoom {
  /** Roster ids to move into empty IR slots, in roster order. */
  readonly irMoves: readonly string[]
  /** Open active-roster spots after the IR moves; never negative. */
  readonly open: number
}

/**
 * Move players whom Yahoo lets occupy an IR slot now into the empty IR slots, in roster order, then count
 * open active spots. A player qualifies when his positions include `IR`, his slot is not locked, and he is
 * not already in IR; Yahoo lists `IR` only for players whose status allows the slot, and none of them can start.
 * @param players - roster players by short id, in roster order.
 * @param slots - league roster slots from Yahoo settings.
 * @returns IR moves and open active-roster spots.
 */
export function rosterRoom(players: ReadonlyMap<string, FantasyPlayer>, slots: readonly FantasyRosterSlot[]): RosterRoom {
  const count = (ir: boolean): number => slots.filter(slot => (slot.position.toUpperCase() === IR) === ir)
    .reduce((sum, slot) => sum + slot.count, 0)
  const roster = [...players]
  const empty = Math.max(0, count(true) - roster.filter(([, player]) => inIr(player)).length)
  const irMoves = roster.filter(([, player]) => !inIr(player) && player.slotLocked !== true
    && player.positions.some(position => position.toUpperCase() === IR))
    .slice(0, empty).map(([id]) => id)
  const active = roster.filter(([, player]) => !inIr(player)).length - irMoves.length
  return { irMoves, open: Math.max(0, count(false) - active) }
}

/**
 * Report weeks of the horizon.
 * @param week - report week.
 * @param count - horizon length.
 * @param lastWeek - last report week.
 * @returns consecutive weeks from the report week, never past the last report week.
 */
export function horizonWeeks(week: number, count: number, lastWeek: number): number[] {
  return Array.from({ length: Math.max(1, Math.min(count, lastWeek - week + 1)) }, (_, index) => week + index)
}

/**
 * One player as a later horizon week sees him. Yahoo injury statuses describe the next game, so Q, D, O,
 * and GTD apply only to the report week, while IR, PUP, NFI, SUSP, and NA statuses carry over; a slot lock
 * applies only to the report week; the projection is that week's.
 * @param player - player as the report week sees him.
 * @param projectedPoints - his projection for the later week, when the provider matched him.
 * @returns the later week's view.
 */
export function laterWeekView(player: FantasyPlayer, projectedPoints: number | undefined): FantasyPlayer {
  const { status, slotLocked: _slotLocked, projectedPoints: _projectedPoints, injuryNote, ...rest } = player
  const lasting = status !== undefined && LASTING_STATUSES.has(status.toUpperCase())
  return { ...rest, ...(lasting ? { status, ...(injuryNote === undefined ? {} : { injuryNote }) } : {}),
    ...(projectedPoints === undefined ? {} : { projectedPoints }) }
}

/** The roster as one horizon week sees it. */
export interface HorizonWeek {
  readonly week: number
  /** Active roster players by short id: IR-slotted players and planned IR moves are left out. */
  readonly players: ReadonlyMap<string, FantasyPlayer>
}

/**
 * Projected points of the best legal lineup a roster can field in one week.
 * @param players - roster players by short id as that week sees them.
 * @param slots - league roster slots from Yahoo settings.
 * @param week - the week, for bye and status checks.
 * @returns summed projections of the chosen starters, counting a missing projection as zero.
 */
export function bestTotal(players: ReadonlyMap<string, FantasyPlayer>, slots: readonly FantasyRosterSlot[], week: number): number {
  return optimizeLineup(players, slots, week).reduce((sum, item) => sum
    + (item.player === undefined ? 0 : (players.get(item.player) as FantasyPlayer).projectedPoints ?? 0), 0)
}

/** One horizon week's byes and the starting slots the roster cannot fill. */
export interface ByeWeek {
  readonly week: number
  /** Active roster ids on bye that week, in roster order. */
  readonly bye: readonly string[]
  /** Starting slots no available active player can fill that week, in Yahoo slot order. */
  readonly empty: readonly string[]
}

/**
 * Byes and unfillable starting slots for each horizon week.
 * @param weeks - roster views of the horizon weeks.
 * @param slots - league roster slots from Yahoo settings.
 * @returns one entry per horizon week.
 */
export function byeOutlook(weeks: readonly HorizonWeek[], slots: readonly FantasyRosterSlot[]): ByeWeek[] {
  return weeks.map(({ week, players }) => ({
    week,
    bye: [...players].filter(([, player]) => player.byeWeek === week).map(([id]) => id),
    empty: optimizeLineup(players, slots, week).flatMap(item => item.player === undefined ? [item.slot] : []),
  }))
}

/** Hundredths-rounded points, so reported values compare and print stably. */
function round(value: number): number {
  return Math.round(value * 100) / 100
}

/** Value of adding one available player over the horizon. */
export interface AddValue {
  /** Average weekly best-lineup gain with the player added and nobody dropped. */
  readonly gain: number
  /** Average weekly gain after the paired drop; equals `gain` when the roster has an open spot. */
  readonly net: number
  /** Roster id of the cheapest drop when the roster has no open spot. */
  readonly drop?: string
  /** Net gain per horizon week, in horizon order. */
  readonly perWeek: readonly number[]
}

/** Roster views, best-lineup totals, and drop rules shared by every candidate of one report. */
export interface HorizonBase {
  readonly weeks: readonly HorizonWeek[]
  readonly slots: readonly FantasyRosterSlot[]
  /** Best-lineup total per horizon week without any move. */
  readonly totals: readonly number[]
  /** Whether an add needs a drop because the roster has no open spot after the IR moves. */
  readonly full: boolean
  /** Roster ids that may be dropped: not locked, not in IR, and not moved to IR. */
  readonly droppable: readonly string[]
}

/**
 * Build the shared horizon base.
 * @param weeks - roster views of the horizon weeks.
 * @param slots - league roster slots from Yahoo settings.
 * @param room - IR moves and open spots.
 * @param roster - report-week roster by short id, for lock and IR checks.
 * @returns totals and drop rules for {@link addValue} and {@link dropCosts}.
 */
export function horizonBase(weeks: readonly HorizonWeek[], slots: readonly FantasyRosterSlot[], room: RosterRoom,
  roster: ReadonlyMap<string, FantasyPlayer>): HorizonBase {
  return {
    weeks, slots, totals: weeks.map(item => bestTotal(item.players, slots, item.week)), full: room.open === 0,
    droppable: [...roster].filter(([id, player]) => player.slotLocked !== true && !inIr(player) && !room.irMoves.includes(id))
      .map(([id]) => id),
  }
}

/** Average of the per-week values. */
function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/**
 * The first base position Yahoo lists for a player, without flex and IR eligibility.
 * @param player - player with Yahoo eligible positions.
 * @returns an uppercase position, or undefined when Yahoo lists none.
 */
export function basePosition(player: FantasyPlayer): string | undefined {
  return player.positions.map(position => position.toUpperCase()).find(position => !position.includes('/') && position !== IR)
}

/**
 * Marginal value of adding one available player: per horizon week, the best-lineup total with him added
 * (and, when the roster has no open spot, the cheapest droppable player removed) minus the current
 * best-lineup total, averaged over the horizon. Among equally cheap drops, one at the candidate's position
 * goes first, so a kicker or defense upgrade pairs with the player it replaces, then the earlier roster id.
 * @param base - shared horizon base.
 * @param id - the candidate's stage id, distinct from every roster id.
 * @param candidate - the candidate as each horizon week sees him, in horizon order.
 * @returns gain without a drop, net gain after the paired drop, the drop, and per-week net gains.
 */
export function addValue(base: HorizonBase, id: string, candidate: readonly FantasyPlayer[]): AddValue {
  const withAdd = base.weeks.map((item, at) => new Map([...item.players, [id, candidate[at] as FantasyPlayer]]))
  const gains = withAdd.map((players, at) => round(bestTotal(players, base.slots, (base.weeks[at] as HorizonWeek).week)
    - (base.totals[at] as number)))
  const gain = round(average(gains))
  if (!base.full || gain <= 0) return { gain, net: gain, perWeek: gains }
  const position = basePosition(candidate[0] as FantasyPlayer)
  let best: { readonly drop: string; readonly perWeek: number[]; readonly net: number; readonly same: boolean } | undefined
  for (const drop of base.droppable) {
    const perWeek = withAdd.map((players, at) => {
      const without = new Map(players)
      without.delete(drop)
      return round(bestTotal(without, base.slots, (base.weeks[at] as HorizonWeek).week) - (base.totals[at] as number))
    })
    const net = round(average(perWeek))
    const player = (base.weeks[0] as HorizonWeek).players.get(drop)
    const same = player !== undefined && position !== undefined && basePosition(player) === position
    if (best === undefined || net > best.net || (net === best.net && same && !best.same)) best = { drop, perWeek, net, same }
  }
  if (best === undefined) return { gain, net: gain, perWeek: gains }
  return { gain, net: best.net, drop: best.drop, perWeek: best.perWeek }
}

/**
 * Average weekly best-lineup points lost by dropping each droppable roster player.
 * @param base - shared horizon base.
 * @returns cost by roster id, in droppable order.
 */
export function dropCosts(base: HorizonBase): Map<string, number> {
  return new Map(base.droppable.map(drop => [drop, round(average(base.weeks.map((item, at) => {
    const without = new Map(item.players)
    without.delete(drop)
    return (base.totals[at] as number) - bestTotal(without, base.slots, item.week)
  })))]))
}

/** A rostered player beyond his position's starting need and one bye cover. */
export interface TradeChip {
  readonly id: string
  readonly position: string
  /** Healthy rostered players at the position. */
  readonly healthy: number
  /** Starting slots the position can fill, counting each flex slot that accepts it. */
  readonly need: number
  /** His average projection over the horizon. */
  readonly average: number
}

/**
 * Name the trade chip: at each base position, healthy rostered players (active, and able to play in the
 * report week) beyond the position's starting need plus one bye cover are surplus, ranked by horizon
 * projection after the starters and the cover; the chip is the surplus player with the highest average
 * horizon projection.
 * @param weeks - roster views of the horizon weeks; the first is the report week.
 * @param slots - league roster slots from Yahoo settings.
 * @returns the chip, or undefined when no position has a surplus.
 */
export function tradeChip(weeks: readonly HorizonWeek[], slots: readonly FantasyRosterSlot[]): TradeChip | undefined {
  const current = weeks[0] as HorizonWeek
  const starting = startingSlots(slots)
  const projection = (id: string): number => average(weeks.map(item => item.players.get(id)?.projectedPoints ?? 0))
  let chip: TradeChip | undefined
  for (const position of new Set(starting.filter(slot => !isFlex(slot)))) {
    const need = starting.filter(slot => slotAccepts(slot, position)).length
    const healthy = [...current.players].filter(([, player]) => basePosition(player) === position
      && unavailableReason({ ...player, byeWeek: undefined }, current.week) === undefined)
      .map(([id]) => ({ id, average: round(projection(id)) })).sort((a, b) => b.average - a.average)
    const best = healthy[need + 1]
    if (best !== undefined && (chip === undefined || best.average > chip.average)) {
      chip = { id: best.id, position, healthy: healthy.length, need, average: best.average }
    }
  }
  return chip
}
