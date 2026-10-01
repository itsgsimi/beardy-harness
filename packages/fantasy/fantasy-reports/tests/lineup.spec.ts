import { describe, expect, it } from 'vitest'
import {
  eligibleFor, isFlex, lineupChanges, optimizeLineup, startingSlots, startsNow, uncertain, unavailableReason,
} from '../src/lineup.ts'
import { lockedRoster, rosterIds, synthetic as player, yahoo } from './support.ts'

const slots = yahoo.settings.rosterSlots
const fixture = new Map(yahoo.roster.players.map((player, index) => [rosterIds[index]!, player]))

/** `slot:id` per starting slot, in Yahoo slot order. */
function shape(lineup: ReturnType<typeof optimizeLineup>): string[] {
  return lineup.map(item => `${item.slot}:${item.player ?? '-'}`)
}

describe('legal lineup search', () => {
  it('keeps Yahoo\'s own lineup when Yahoo supplies no player projections', () => {
    expect(startingSlots(slots)).toEqual(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'W/R/T', 'K', 'DEF'])
    const lineup = optimizeLineup(fixture, slots, 3)
    expect(shape(lineup)).toEqual(['QB:P1', 'RB:P2', 'RB:P3', 'WR:P4', 'WR:P5', 'TE:P6', 'W/R/T:P7', 'K:P14', 'DEF:P15'])
    expect(lineupChanges(lineup, fixture, slots)).toEqual({ start: [], bench: [] })
  })

  it('maximizes summed projections across the flex, keeping current starters only to break ties', () => {
    const players = new Map([
      ['P1', player('Quarter', ['QB'], { projectedPoints: 18, selectedSlot: 'QB' })],
      ['P2', player('Runner', ['RB'], { projectedPoints: 9, selectedSlot: 'RB' })],
      ['P3', player('Wideout', ['WR'], { projectedPoints: 11, selectedSlot: 'W/R/T' })],
      ['P4', player('Tight', ['TE'], { projectedPoints: 12.4, selectedSlot: 'BN' })],
      ['P5', player('Bench Back', ['RB'], { projectedPoints: 9, selectedSlot: 'BN' })],
    ])
    const league = [{ position: 'QB', count: 1, starting: true }, { position: 'RB', count: 1, starting: true },
      { position: 'W/R/T', count: 1, starting: true }, { position: 'BN', count: 3, starting: false }]
    const lineup = optimizeLineup(players, league, 3)
    expect(shape(lineup)).toEqual(['QB:P1', 'RB:P2', 'W/R/T:P4'])
    expect(lineupChanges(lineup, players, league)).toEqual({ start: ['P4'], bench: ['P3'] })
    expect(shape(optimizeLineup(players, league, 3, new Set(['P1', 'P5', 'P3'])))).toEqual(['QB:P1', 'RB:P5', 'W/R/T:P3'])
  })

  it('never starts players on bye or listed out, and leaves a slot empty when nobody eligible can play', () => {
    const players = new Map([
      ['P1', player('Out Quarter', ['QB'], { status: 'O', selectedSlot: 'QB', projectedPoints: 20 })],
      ['P2', player('Bye Kicker', ['K'], { byeWeek: 3, selectedSlot: 'K', projectedPoints: 8 })],
      ['P3', player('Backup Quarter', ['QB'], { selectedSlot: 'BN', projectedPoints: 12 })],
    ])
    const league = [{ position: 'QB', count: 1, starting: true }, { position: 'K', count: 1, starting: true }]
    expect(shape(optimizeLineup(players, league, 3))).toEqual(['QB:P3', 'K:-'])
    expect(unavailableReason(players.get('P1')!, 3)).toBe('Yahoo status O')
    expect(unavailableReason(players.get('P2')!, 3)).toBe('on bye in week 3')
    expect(unavailableReason(players.get('P3')!, 3)).toBeUndefined()
  })

  it('keeps locked starters in their Yahoo slot, even when unavailable, and locked reserves out', () => {
    const locked = new Map(lockedRoster([3, 9]).players.map((item, index) => [rosterIds[index]!, item]))
    const boosted = new Map([...locked].map(([id, item]) => [id, id === 'P10' ? { ...item, projectedPoints: 40 }
      : id === 'P4' ? { ...item, status: 'O' } : item]))
    const lineup = optimizeLineup(boosted, slots, 3)
    expect(lineup.find(item => item.player === 'P4')?.slot).toBe('WR')
    expect(lineup.some(item => item.player === 'P10')).toBe(false)
    const slotless = new Map([['P1', player('Slotless', ['QB'], { slotLocked: true, projectedPoints: 30 })],
      ['P2', player('Starter', ['QB'], { projectedPoints: 1 })]])
    expect(shape(optimizeLineup(slotless, [{ position: 'QB', count: 1, starting: true }], 3))).toEqual(['QB:P2'])
  })

  it('reads eligibility, flex slots, uncertain statuses, and current starters from Yahoo fields', () => {
    const back = player('Back', ['RB'])
    expect(eligibleFor(back, 'W/R/T')).toBe(true)
    expect(eligibleFor(back, 'W/T')).toBe(false)
    expect(eligibleFor(player('Flexed', ['W/T']), 'W/T')).toBe(true)
    expect(isFlex('Q/W/R/T')).toBe(true)
    expect(isFlex('QB')).toBe(false)
    expect(['Q', 'd', 'GTD', 'O', undefined].map(status => uncertain(player('S', ['WR'], status === undefined ? {} : { status }))))
      .toEqual([true, true, true, false, false])
    expect(startsNow(player('Unslotted', ['WR']), ['WR'])).toBe(false)
    expect(startsNow(player('Slotted', ['WR'], { selectedSlot: 'wr' }), ['WR'])).toBe(true)
  })
})
