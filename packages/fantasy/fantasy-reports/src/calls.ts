/**
 * Reconcile model calls with the code lineup: code keeps a legal lineup whose starters are exactly the
 * players called START or FLEX, and rejects calls it cannot honor.
 * @module @deepseek-ai/dsh-fantasy-reports/calls
 */

import type { FantasyPlayer, FantasyRosterSlot } from '@deepseek-ai/dsh-fantasy/types'
import type { ModelCall } from './answers.ts'
import { type CallChoice, lineupCall, plainReason, slotOf } from './facts.ts'
import { eligibleFor, isFlex, type LineupAssignment, optimizeLineup, startingSlots, unavailableReason } from './lineup.ts'

/** Where a player's final call and reason came from. */
export type CallOrigin =
  /** A valid model call that code kept. */
  | 'model'
  /** No valid model answer after the retry; code default call and plain reason. */
  | 'default'
  /** A valid model call that code rejected; lineup call and plain reason. */
  | 'overridden'
  /** A kept model call whose reason the reason check flagged; plain reason. */
  | 'unsupported'

/** One player's final call. */
export interface PlayerCall {
  readonly call: CallChoice
  readonly reason: string
  /** Cited source ids. */
  readonly sources: readonly number[]
  readonly origin: CallOrigin
  /** Why code rejected the model call, for `overridden`. */
  readonly note?: string
}

/** A lineup and one final call per roster player. */
export interface Reconciled {
  readonly lineup: readonly LineupAssignment[]
  readonly calls: ReadonlyMap<string, PlayerCall>
}

function starts(call: CallChoice): boolean {
  return call === 'START' || call === 'FLEX'
}

/** Why code cannot honor a call on its own, before any lineup search. */
function refusal(player: FantasyPlayer, call: CallChoice, starting: readonly string[], inLineup: boolean,
  week: number): string | undefined {
  if (player.slotLocked === true && starts(call) !== inLineup) return 'Yahoo has locked his slot because his game has started'
  const unavailable = unavailableReason(player, week)
  if (starts(call) && unavailable !== undefined && player.slotLocked !== true) return `he cannot start while ${unavailable}`
  if (call === 'FLEX' && !starting.some(slot => isFlex(slot) && eligibleFor(player, slot))) return 'no flex slot in this league accepts him'
  return undefined
}

/**
 * Apply model calls to the code lineup. Benching or starting a player happens only in legal swaps: all
 * requested changes at once when the starters they leave fill the lineup as well as the code lineup
 * did, otherwise one bench-for-starter pair at a time in roster order. Unpaired changes, starts of
 * unavailable players, FLEX where no flex slot fits, and moves of locked players are rejected. A
 * starter's call follows his final slot (FLEX in a flex slot, START otherwise).
 * @param players - roster players by short id, in roster order.
 * @param slots - league roster slots from Yahoo settings.
 * @param week - report week.
 * @param code - code lineup.
 * @param model - valid model calls by roster id.
 * @returns the final lineup and calls.
 */
export function reconcileCalls(players: ReadonlyMap<string, FantasyPlayer>, slots: readonly FantasyRosterSlot[], week: number,
  code: readonly LineupAssignment[], model: ReadonlyMap<string, ModelCall>): Reconciled {
  const starting = startingSlots(slots)
  const empties = (lineup: readonly LineupAssignment[]): number => lineup.filter(item => item.player === undefined).length
  const fit = (pool: ReadonlySet<string>): readonly LineupAssignment[] | undefined => {
    const lineup = optimizeLineup(players, slots, week, pool)
    return [...pool].every(id => slotOf(lineup, id) !== undefined) && empties(lineup) <= empties(code) ? lineup : undefined
  }
  const notes = new Map<string, string>()
  const promote: string[] = []
  const demote: string[] = []
  for (const [id, answer] of model) {
    const inLineup = slotOf(code, id) !== undefined
    const refused = refusal(players.get(id) as FantasyPlayer, answer.call, starting, inLineup, week)
    if (refused !== undefined) notes.set(id, refused)
    else if (starts(answer.call) && !inLineup) promote.push(id)
    else if (!starts(answer.call) && inLineup) demote.push(id)
  }
  let current = new Set(code.flatMap(item => item.player ?? []))
  let lineup = code
  const all = new Set([...current].filter(id => !demote.includes(id)).concat(promote))
  const together = promote.length + demote.length === 0 ? undefined : fit(all)
  if (together !== undefined) {
    lineup = together
  } else {
    const paired = new Set<string>()
    for (const up of promote) {
      for (const down of demote.filter(id => !paired.has(id))) {
        const pool = new Set([...current].filter(id => id !== down).concat(up))
        const swapped = fit(pool)
        if (swapped === undefined) continue
        current = pool
        lineup = swapped
        paired.add(up).add(down)
        break
      }
    }
    for (const id of [...promote, ...demote]) if (!paired.has(id)) notes.set(id, 'no legal lineup swap honors it')
  }
  const calls = new Map<string, PlayerCall>()
  for (const [id, player] of players) {
    const slot = slotOf(lineup, id)
    const answer = model.get(id)
    const note = notes.get(id)
    if (answer === undefined || note !== undefined) {
      calls.set(id, { call: lineupCall(player, slot, week), reason: plainReason(player, slot, week), sources: [],
        origin: answer === undefined ? 'default' : 'overridden', ...(note === undefined ? {} : { note }) })
    } else {
      calls.set(id, { call: slot === undefined ? answer.call : lineupCall(player, slot, week), reason: answer.reason,
        sources: answer.sources, origin: 'model' })
    }
  }
  return { lineup, calls }
}
