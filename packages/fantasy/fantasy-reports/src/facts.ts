/**
 * Code-owned report facts: default calls and reasons, close-call pairs, position needs, and the waiver
 * shortlist. Everything here is deterministic over Yahoo data and the code lineup.
 * @module @deepseek-ai/dsh-fantasy-reports/facts
 */

import type { FantasyPlayer, FantasyRosterSlot } from '@deepseek-ai/dsh-fantasy/types'
import { eligibleFor, isFlex, type LineupAssignment, startingSlots, startsNow, uncertain, unavailableReason } from './lineup.ts'
import type { AddValue } from './moves.ts'

/** A per-player call: START and FLEX start in a position or flex slot, SIT benches, HOLD benches and keeps. */
export type CallChoice = 'START' | 'SIT' | 'FLEX' | 'HOLD'

/** Every call a model may answer. */
export const CALLS: readonly CallChoice[] = ['START', 'SIT', 'FLEX', 'HOLD']

/** Sort value of a missing projection or rank; finite so differences of two missing values are zero. */
const UNPROJECTED = -1e9

/** One verbatim news excerpt and the admitted page it came from. */
export interface Excerpt {
  /** Admitted page number, cited as a source id. */
  readonly source: number
  readonly text: string
}

/**
 * The slot a lineup gives a player.
 * @param lineup - starting assignments.
 * @param id - roster id.
 * @returns the starting slot, or undefined on the bench.
 */
export function slotOf(lineup: readonly LineupAssignment[], id: string): string | undefined {
  return lineup.find(assignment => assignment.player === id)?.slot
}

/**
 * The call a lineup implies for a player.
 * @param player - roster player.
 * @param slot - the player's starting slot, or undefined on the bench.
 * @param week - report week.
 * @returns FLEX or START for a starter, HOLD for an unavailable reserve, otherwise SIT.
 */
export function lineupCall(player: FantasyPlayer, slot: string | undefined, week: number): CallChoice {
  if (slot !== undefined) return isFlex(slot) ? 'FLEX' : 'START'
  return unavailableReason(player, week) === undefined ? 'SIT' : 'HOLD'
}

/**
 * Format a projection for prompts and reports.
 * @param value - projected points.
 * @returns one decimal, or `n/a`.
 */
export function points(value: number | undefined): string {
  return value === undefined ? 'n/a' : value.toFixed(1)
}

/**
 * A plain reason built only from Yahoo facts, the player's projection, and the lineup, used when no model reason is usable.
 * @param player - roster player.
 * @param slot - the player's starting slot, or undefined on the bench.
 * @param week - report week.
 * @returns one or two short sentences.
 */
export function plainReason(player: FantasyPlayer, slot: string | undefined, week: number): string {
  const projection = player.projectedPoints === undefined ? 'no projection' : `projected ${points(player.projectedPoints)}`
  const status = player.status === undefined ? '' : ` Yahoo lists him ${player.status}${player.injuryNote === undefined ? '' : ` (${player.injuryNote})`}.`
  if (player.slotLocked === true) {
    return slot === undefined ? 'Yahoo has locked him on the bench because his game has started.'
      : `Yahoo has locked him in ${slot} because his game has started.`
  }
  if (slot !== undefined) return `Starts at ${slot}; ${projection}.${status}`
  const unavailable = unavailableReason(player, week)
  if (unavailable !== undefined) return `Benched: ${unavailable}${player.injuryNote === undefined ? '' : ` (${player.injuryNote})`}.`
  return `Benched; ${projection}, and the starters rank ahead of him.${status}`
}

/** A starter and a bench player close enough that the choice between them deserves a comparison. */
export interface ClosePair {
  /** Stage id, such as `C1`. */
  readonly id: string
  readonly starter: string
  readonly bench: string
  /** Slot the two compete for. */
  readonly slot: string
  /** Why code flagged the pair. */
  readonly why: 'projection' | 'status'
}

/**
 * Flag starter and bench pairs worth a comparison: an uncertain starter (Yahoo Q, D, or GTD) with his best
 * eligible available backup, then pairs whose projections differ by at most the margin, closest first.
 * Locked players and players Yahoo lists as unable to play are never paired.
 * @param players - roster players by short id, in roster order.
 * @param lineup - final starting assignments.
 * @param week - report week.
 * @param margin - largest projection difference, in points.
 * @param limit - most pairs returned.
 * @returns pairs with stage ids `C1`, `C2`, and so on.
 */
export function closePairs(players: ReadonlyMap<string, FantasyPlayer>, lineup: readonly LineupAssignment[], week: number,
  margin: number, limit: number): ClosePair[] {
  const free = (id: string): boolean => {
    const player = players.get(id) as FantasyPlayer
    return player.slotLocked !== true && unavailableReason(player, week) === undefined
  }
  const starters = lineup.flatMap(item => item.player !== undefined && free(item.player) ? [{ id: item.player, slot: item.slot }] : [])
  const bench = [...players.keys()].filter(id => slotOf(lineup, id) === undefined && free(id))
  const projected = (id: string): number | undefined => players.get(id)?.projectedPoints
  const pairs: Array<Omit<ClosePair, 'id'> & { readonly gap: number }> = []
  for (const { id, slot } of starters) {
    const options = bench.filter(other => eligibleFor(players.get(other) as FantasyPlayer, slot))
      .sort((a, b) => (projected(b) ?? UNPROJECTED) - (projected(a) ?? UNPROJECTED))
    if (uncertain(players.get(id) as FantasyPlayer) && options.length > 0) {
      pairs.push({ starter: id, bench: options[0] as string, slot, why: 'status', gap: -1 })
      continue
    }
    for (const other of options) {
      const a = projected(id)
      const b = projected(other)
      if (a !== undefined && b !== undefined && Math.abs(a - b) <= margin) {
        pairs.push({ starter: id, bench: other, slot, why: 'projection', gap: Math.abs(a - b) })
      }
    }
  }
  return pairs.sort((a, b) => a.gap - b.gap).slice(0, limit)
    .map(({ gap: _gap, ...pair }, index) => ({ id: `C${index + 1}`, ...pair }))
}

/** A base roster position and why it needs help this week. */
export interface PositionNeed {
  readonly position: string
  /** Weight of this week's problems: 2 per empty slot, 1 per uncertain or unavailable Yahoo starter. */
  readonly need: number
  readonly reasons: readonly string[]
}

/**
 * Base positions of the league's starting slots, without flex slots.
 * @param slots - league roster slots from Yahoo settings.
 * @returns distinct uppercase positions in Yahoo order.
 */
export function basePositions(slots: readonly FantasyRosterSlot[]): string[] {
  return [...new Set(startingSlots(slots).filter(slot => !isFlex(slot)))]
}

/**
 * Score each base position by this week's problems: empty starting slots, uncertain starters, and Yahoo
 * starters who cannot play.
 * @param players - roster players by short id.
 * @param lineup - code starting assignments.
 * @param slots - league roster slots from Yahoo settings.
 * @param week - report week.
 * @returns one entry per base position, in Yahoo order.
 */
export function positionNeeds(players: ReadonlyMap<string, FantasyPlayer>, lineup: readonly LineupAssignment[],
  slots: readonly FantasyRosterSlot[], week: number): PositionNeed[] {
  const starting = startingSlots(slots)
  return basePositions(slots).map((position) => {
    const reasons: string[] = []
    let need = 0
    const empty = lineup.filter(item => item.slot === position && item.player === undefined).length
    if (empty > 0) {
      need += 2 * empty
      reasons.push(`empty ${position} slots: ${empty}`)
    }
    for (const item of lineup) {
      const player = item.player === undefined ? undefined : players.get(item.player) as FantasyPlayer
      if (item.slot === position && player !== undefined && uncertain(player)) {
        need++
        reasons.push(`${player.name} is ${player.status as string}`)
      }
    }
    for (const player of players.values()) {
      const reason = unavailableReason(player, week)
      if (reason !== undefined && player.slotLocked !== true && (player.selectedSlot ?? '').toUpperCase() === position
        && startsNow(player, starting)) {
        need++
        reasons.push(`Yahoo starter ${player.name} is ${reason}`)
      }
    }
    return { position, need, reasons }
  })
}

/** An available player read for a base position and valued over the horizon. */
export interface PoolEntry {
  /** His base position: his first Yahoo base position, or the list that returned him. */
  readonly position: string
  /** The player as the report week sees him, with his report-week projection. */
  readonly player: FantasyPlayer
  /** The player as each horizon week sees him, in horizon order. */
  readonly weeks: readonly FantasyPlayer[]
  readonly value: AddValue
}

/** An available player code shortlisted for the waiver stage. */
export interface WaiverCandidate extends PoolEntry {
  /** Stage id, such as `W1`. */
  readonly id: string
}

/**
 * How a team acquires an available player.
 * @param player - available player with Yahoo ownership.
 * @returns `claim` when Yahoo lists him on waivers, otherwise `free agent`, an immediate add.
 */
export function acquisition(player: FantasyPlayer): 'claim' | 'free agent' {
  return player.ownershipType === 'waivers' ? 'claim' : 'free agent'
}

/** Best first: net value, then gain without a drop, then Yahoo rank, then percent owned. */
function byValue(a: PoolEntry, b: PoolEntry): number {
  return b.value.net - a.value.net || b.value.gain - a.value.gain || (a.player.rank ?? -UNPROJECTED) - (b.player.rank ?? -UNPROJECTED)
    || (b.player.percentOwned ?? -1) - (a.player.percentOwned ?? -1)
}

/**
 * Shortlist available players whose add raises the best-lineup projection over the horizon. Positions rank
 * by their best candidate's net value; each kept position keeps its best candidates by net value.
 * @param pool - valued available players.
 * @param bounds - positions kept and candidates per position.
 * @returns kept positions, best first, and candidates with stage ids `W1`, `W2`, and so on in that order.
 */
export function waiverShortlist(pool: readonly PoolEntry[],
  bounds: { readonly positions: number; readonly candidates: number }): { positions: string[]; candidates: WaiverCandidate[] } {
  const ranked = pool.filter(entry => entry.value.net > 0).sort(byValue)
  const positions = [...new Set(ranked.map(entry => entry.position))].slice(0, bounds.positions)
  const candidates = positions.flatMap(position => ranked.filter(entry => entry.position === position).slice(0, bounds.candidates))
    .map((entry, index) => ({ id: `W${index + 1}`, ...entry }))
  return { positions, candidates }
}

/**
 * The free agent to add if a waiver claim fails: the best immediate add at the claim's position.
 * @param pool - valued available players.
 * @param claim - the claimed candidate.
 * @param taken - player keys already suggested.
 * @returns the fallback, or undefined when no free agent at the position adds value.
 */
export function freeAgentFallback(pool: readonly PoolEntry[], claim: PoolEntry, taken: ReadonlySet<string>): PoolEntry | undefined {
  return pool.filter(entry => entry.position === claim.position && entry.value.net > 0 && acquisition(entry.player) === 'free agent'
    && !taken.has(entry.player.key)).sort(byValue)[0]
}
