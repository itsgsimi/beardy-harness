/**
 * Code-owned report facts: default calls and reasons, close-call pairs, weak positions, and the waiver
 * shortlist. Everything here is deterministic over Yahoo data and the code lineup.
 * @module @deepseek-ai/dsh-fantasy-reports/facts
 */

import type { FantasyPlayer, FantasyRosterSlot } from '@deepseek-ai/dsh-fantasy/types'
import { eligibleFor, isFlex, type LineupAssignment, startingSlots, startsNow, uncertain, unavailableReason } from './lineup.ts'

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
 * Format a Yahoo projection for prompts and reports.
 * @param value - projected points.
 * @returns one decimal, or `n/a`.
 */
export function points(value: number | undefined): string {
  return value === undefined ? 'n/a' : value.toFixed(1)
}

/**
 * A plain reason built only from Yahoo facts and the lineup, used when no model reason is usable.
 * @param player - roster player.
 * @param slot - the player's starting slot, or undefined on the bench.
 * @param week - report week.
 * @returns one or two short sentences.
 */
export function plainReason(player: FantasyPlayer, slot: string | undefined, week: number): string {
  const projection = player.projectedPoints === undefined ? 'Yahoo shows no projection' : `Yahoo projects ${points(player.projectedPoints)}`
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
 * eligible available backup, then pairs whose Yahoo projections differ by at most the margin, closest first.
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

/** A free agent code shortlisted for the waiver stage. */
export interface WaiverCandidate {
  /** Stage id, such as `W1`. */
  readonly id: string
  /** Weak position the candidate fills. */
  readonly position: string
  readonly player: FantasyPlayer
}

/** A weak position chosen for the shortlist. */
export interface WeakPosition extends PositionNeed {
  /** Best free-agent projection minus the worst starter projection at the position, when both exist and it is positive. */
  readonly gap?: number
}

/**
 * Positions whose free agents must be read: those with a need, or every base position when any roster
 * player has a Yahoo projection, since a projection gap can then show weakness.
 * @param needs - scored base positions.
 * @param players - roster players by short id.
 * @returns positions to request, in Yahoo order.
 */
export function waiverQueries(needs: readonly PositionNeed[], players: ReadonlyMap<string, FantasyPlayer>): string[] {
  const projected = [...players.values()].some(player => player.projectedPoints !== undefined)
  return needs.filter(item => item.need > 0 || projected).map(item => item.position)
}

/**
 * Choose the weakest positions and their best available free agents. A position qualifies by need or a
 * positive projection gap and ranks by need, then gap. Candidates must be eligible for the position and
 * able to play this week, and rank by Yahoo projection, then Yahoo rank, then percent owned.
 * @param needs - scored base positions.
 * @param freeAgents - free agents read per position.
 * @param players - roster players by short id.
 * @param lineup - code starting assignments.
 * @param week - report week.
 * @param bounds - weak positions kept and candidates per position.
 * @returns weak positions and candidates with stage ids `W1`, `W2`, and so on.
 */
export function waiverShortlist(needs: readonly PositionNeed[], freeAgents: ReadonlyMap<string, readonly FantasyPlayer[]>,
  players: ReadonlyMap<string, FantasyPlayer>, lineup: readonly LineupAssignment[], week: number,
  bounds: { readonly positions: number; readonly candidates: number }): { positions: WeakPosition[]; candidates: WaiverCandidate[] } {
  const scored = needs.flatMap((item, order): Array<WeakPosition & { readonly order: number }> => {
    const pool = (freeAgents.get(item.position) ?? []).filter(player => eligibleFor(player, item.position)
      && unavailableReason(player, week) === undefined)
    const starters = lineup.flatMap(entry => entry.slot === item.position && entry.player !== undefined
      ? [players.get(entry.player)?.projectedPoints] : [])
    const worst = starters.some(value => value === undefined) || starters.length === 0
      ? undefined : Math.min(...starters as number[])
    const best = pool.reduce<number | undefined>((top, player) => player.projectedPoints === undefined ? top
      : Math.max(top ?? Number.NEGATIVE_INFINITY, player.projectedPoints), undefined)
    const gap = worst === undefined || best === undefined || best <= worst ? undefined : Math.round((best - worst) * 10) / 10
    if (pool.length === 0 || (item.need === 0 && gap === undefined)) return []
    return [{ ...item, ...(gap === undefined ? {} : { gap }), order }]
  }).sort((a, b) => b.need - a.need || (b.gap ?? 0) - (a.gap ?? 0) || a.order - b.order).slice(0, bounds.positions)
  const rank = (a: FantasyPlayer, b: FantasyPlayer): number =>
    (b.projectedPoints ?? UNPROJECTED) - (a.projectedPoints ?? UNPROJECTED) || (a.rank ?? -UNPROJECTED) - (b.rank ?? -UNPROJECTED)
    || (b.percentOwned ?? -1) - (a.percentOwned ?? -1)
  const seen = new Set<string>()
  const candidates: WaiverCandidate[] = []
  for (const weak of scored) {
    const pool = (freeAgents.get(weak.position) as readonly FantasyPlayer[]).filter(player => eligibleFor(player, weak.position)
      && unavailableReason(player, week) === undefined && !seen.has(player.key))
    for (const player of [...pool].sort(rank).slice(0, bounds.candidates)) {
      seen.add(player.key)
      candidates.push({ id: `W${candidates.length + 1}`, position: weak.position, player })
    }
  }
  return { positions: scored.map(({ order: _order, ...weak }) => weak), candidates }
}
