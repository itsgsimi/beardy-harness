import { describe, expect, it } from 'vitest'
import type { FantasyPlayer } from '@deepseek-ai/dsh-fantasy/types'
import {
  addValue, bestTotal, byeOutlook, dropCosts, horizonBase, type HorizonWeek, horizonWeeks, inIr, laterWeekView, rosterRoom, tradeChip,
} from '../src/moves.ts'
import { synthetic } from './support.ts'

const slots = [{ position: 'QB', count: 1, starting: true }, { position: 'WR', count: 1, starting: true },
  { position: 'W/R/T', count: 1, starting: true }, { position: 'K', count: 1, starting: true },
  { position: 'BN', count: 2, starting: false }, { position: 'IR', count: 2, starting: false }]

/** A five-player roster: one active roster spot of six stays open until an IR move frees another. */
function roster(): Map<string, FantasyPlayer> {
  return new Map([
    ['P1', synthetic('Passer', ['QB'], { selectedSlot: 'QB', projectedPoints: 18, byeWeek: 4 })],
    ['P2', synthetic('Wide', ['WR', 'W/R/T'], { selectedSlot: 'WR', projectedPoints: 10 })],
    ['P3', synthetic('Back', ['RB', 'W/R/T'], { selectedSlot: 'W/R/T', projectedPoints: 8 })],
    ['P4', synthetic('Kicker', ['K'], { selectedSlot: 'K', projectedPoints: 7 })],
    ['P5', synthetic('Hurt Wide', ['WR', 'W/R/T', 'IR'], { selectedSlot: 'BN', status: 'O', projectedPoints: 0 })],
  ])
}

/** Report week 3 and a later week 4 view of the same roster, projections unchanged. */
function weeksOf(players: ReadonlyMap<string, FantasyPlayer>): HorizonWeek[] {
  return [{ week: 3, players }, { week: 4, players: new Map([...players].map(([id, player]) =>
    [id, laterWeekView(player, player.projectedPoints)])) }]
}

describe('roster room and horizon views', () => {
  it('moves IR-eligible unlocked players into empty IR slots and counts the freed spots', () => {
    const players = roster()
    expect(rosterRoom(players, slots)).toEqual({ irMoves: ['P5'], open: 2 })
    players.set('P6', synthetic('Stashed', ['WR', 'IR'], { selectedSlot: 'IR', status: 'IR' }))
    players.set('P7', synthetic('Locked Hurt', ['RB', 'IR'], { selectedSlot: 'BN', slotLocked: true, status: 'O' }))
    players.set('P8', synthetic('Also Hurt', ['RB', 'IR'], { selectedSlot: 'BN', status: 'O' }))
    expect(inIr(players.get('P6')!)).toBe(true)
    expect(rosterRoom(players, slots)).toEqual({ irMoves: ['P5'], open: 0 })
    players.set('P9', synthetic('Extra', ['RB'], { selectedSlot: 'BN' }))
    expect(rosterRoom(players, [...slots.slice(0, 5)])).toEqual({ irMoves: [], open: 0 })
  })

  it('keeps lasting statuses in later weeks and drops next-game statuses, locks, and the report-week projection', () => {
    const out = synthetic('Out', ['WR'], { status: 'O', injuryNote: 'Ankle', slotLocked: true, projectedPoints: 9 })
    expect(laterWeekView(out, 11)).toEqual({ key: out.key, name: 'Out', positions: ['WR'], projectedPoints: 11 })
    expect(laterWeekView(synthetic('Stash', ['WR'], { status: 'IR-R', injuryNote: 'Knee' }), undefined))
      .toMatchObject({ status: 'IR-R', injuryNote: 'Knee' })
    expect(laterWeekView(synthetic('Banned', ['WR'], { status: 'SUSP' }), undefined)).toMatchObject({ status: 'SUSP' })
    expect(horizonWeeks(15, 3, 17)).toEqual([15, 16, 17])
    expect(horizonWeeks(16, 3, 17)).toEqual([16, 17])
    expect(horizonWeeks(17, 6, 17)).toEqual([17])
  })

  it('lists each week\'s byes and the starting slots the roster cannot fill', () => {
    const players = roster()
    expect(bestTotal(players, slots, 3)).toBe(43)
    expect(byeOutlook(weeksOf(players), slots)).toEqual([{ week: 3, bye: [], empty: [] }, { week: 4, bye: ['P1'], empty: ['QB'] }])
  })
})

describe('marginal add value and drop cost', () => {
  it('averages the best-lineup gain of an add over the horizon while a roster spot is open', () => {
    const players = roster()
    const room = rosterRoom(players, slots)
    const weeks = weeksOf(new Map([...players].filter(([id]) => !room.irMoves.includes(id))))
    const base = horizonBase(weeks, slots, room, players)
    expect(base).toMatchObject({ totals: [43, 25], full: false, droppable: ['P1', 'P2', 'P3', 'P4'] })
    const passer = synthetic('Spare Passer', ['QB'], { projectedPoints: 12 })
    expect(addValue(base, 'W1', [passer, laterWeekView(passer, 12)])).toEqual({ gain: 6, net: 6, perWeek: [0, 12] })
    const useless = synthetic('Slow Wide', ['WR'], { projectedPoints: 1 })
    expect(addValue(base, 'W2', [useless, useless])).toEqual({ gain: 0, net: 0, perWeek: [0, 0] })
  })

  it('pairs an add on a full roster with its cheapest drop, preferring the player it replaces at his position', () => {
    const players = roster()
    const full = { irMoves: [], open: 0 }
    const base = horizonBase(weeksOf(players), slots, full, players)
    expect(base.full).toBe(true)
    const kicker = synthetic('Better Kicker', ['K'], { projectedPoints: 9 })
    expect(addValue(base, 'W1', [kicker, laterWeekView(kicker, 9)])).toEqual({ gain: 2, net: 2, drop: 'P4', perWeek: [2, 2] })
    const wide = synthetic('Better Wide', ['WR'], { projectedPoints: 11 })
    expect(addValue(base, 'W2', [wide, laterWeekView(wide, 11)])).toEqual({ gain: 3, net: 3, drop: 'P5', perWeek: [3, 3] })
    expect(addValue({ ...base, droppable: [] }, 'W3', [wide, wide])).toEqual({ gain: 3, net: 3, perWeek: [3, 3] })
    expect([...dropCosts(base)]).toEqual([['P1', 9], ['P2', 10], ['P3', 8], ['P4', 7], ['P5', 0]])
  })
})

describe('trade chip', () => {
  it('names the best healthy player beyond a position\'s starting need and bye cover', () => {
    const players = new Map([
      ['P1', synthetic('First Passer', ['QB'], { projectedPoints: 20 })],
      ['P2', synthetic('Second Passer', ['QB'], { projectedPoints: 15 })],
      ['P3', synthetic('Third Passer', ['QB'], { projectedPoints: 12, byeWeek: 3 })],
      ['P4', synthetic('Hurt Passer', ['QB'], { projectedPoints: 30, status: 'O' })],
      ['P5', synthetic('Wide', ['WR'], { projectedPoints: 9 })],
    ])
    expect(tradeChip(weeksOf(players), slots)).toEqual({ id: 'P3', position: 'QB', healthy: 3, need: 1, average: 12 })
    players.delete('P3')
    expect(tradeChip(weeksOf(players), slots)).toBeUndefined()
    const wides = new Map([...['A', 'B', 'C', 'D'].map((name, index) => [`W${index}`, synthetic(`Wide ${name}`, ['WR'],
      { projectedPoints: 10 - index })] as const), ['Q1', synthetic('Passer', ['QB'], { projectedPoints: 20 })],
    ['Q2', synthetic('Backup', ['QB'], { projectedPoints: 5 })], ['Q3', synthetic('Third', ['QB'], { projectedPoints: 4 })]])
    expect(tradeChip(weeksOf(wides), slots)).toEqual({ id: 'W3', position: 'WR', healthy: 4, need: 2, average: 7 })
    wides.delete('W3')
    expect(tradeChip(weeksOf(wides), slots)).toEqual({ id: 'Q3', position: 'QB', healthy: 3, need: 1, average: 4 })
  })
})
