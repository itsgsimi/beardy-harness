import { describe, expect, it } from 'vitest'
import {
  acquisition, basePositions, closePairs, freeAgentFallback, lineupCall, plainReason, points, type PoolEntry, positionNeeds, slotOf,
  waiverShortlist,
} from '../src/facts.ts'
import { optimizeLineup } from '../src/lineup.ts'
import { rosterIds, synthetic, yahoo } from './support.ts'

const slots = yahoo.settings.rosterSlots
const fixture = new Map(yahoo.roster.players.map((player, index) => [rosterIds[index]!, player]))
const code = optimizeLineup(fixture, slots, 3)
const league = [{ position: 'QB', count: 1, starting: true }, { position: 'WR', count: 1, starting: true },
  { position: 'W/R/T', count: 1, starting: true }, { position: 'BN', count: 4, starting: false }]

describe('code calls and plain reasons', () => {
  it('derives calls from the lineup slot and Yahoo availability', () => {
    const [qb, flex, out] = [fixture.get('P1')!, fixture.get('P7')!, fixture.get('P9')!]
    expect(slotOf(code, 'P7')).toBe('W/R/T')
    expect(slotOf(code, 'P8')).toBeUndefined()
    expect(lineupCall(qb, 'QB', 3)).toBe('START')
    expect(lineupCall(flex, 'W/R/T', 3)).toBe('FLEX')
    expect(lineupCall(out, undefined, 3)).toBe('HOLD')
    expect(lineupCall(fixture.get('P8')!, undefined, 3)).toBe('SIT')
    expect(points(undefined)).toBe('n/a')
    expect(points(12.345)).toBe('12.3')
  })

  it('states only Yahoo facts and the lineup in plain reasons', () => {
    expect(plainReason(fixture.get('P1')!, 'QB', 3)).toBe('Starts at QB; no projection.')
    expect(plainReason(fixture.get('P5')!, 'WR', 3)).toBe('Starts at WR; no projection. Yahoo lists him Q (Hamstring).')
    expect(plainReason(fixture.get('P9')!, undefined, 3)).toBe('Benched: Yahoo status O (Elbow).')
    expect(plainReason(synthetic('Bye', ['WR'], { byeWeek: 3 }), undefined, 3)).toBe('Benched: on bye in week 3.')
    expect(plainReason(synthetic('Depth', ['WR'], { projectedPoints: 7.25, status: 'Q' }), undefined, 3))
      .toBe('Benched; projected 7.3, and the starters rank ahead of him. Yahoo lists him Q.')
    expect(plainReason(synthetic('Locked', ['WR'], { slotLocked: true }), 'WR', 3)).toBe('Yahoo has locked him in WR because his game has started.')
    expect(plainReason(synthetic('Locked', ['WR'], { slotLocked: true }), undefined, 3))
      .toBe('Yahoo has locked him on the bench because his game has started.')
  })
})

describe('close calls', () => {
  it('pairs an uncertain starter with his best available eligible backup', () => {
    expect(closePairs(fixture, code, 3, 2, 3)).toEqual([{ id: 'C1', starter: 'P5', bench: 'P8', slot: 'WR', why: 'status' }])
    expect(closePairs(fixture, code, 3, 2, 0)).toEqual([])
  })

  it('pairs starters and available bench players within the projection margin, closest first', () => {
    const players = new Map([
      ['P1', synthetic('Passer', ['QB'], { projectedPoints: 20, selectedSlot: 'QB' })],
      ['P2', synthetic('Wide One', ['WR'], { projectedPoints: 10, selectedSlot: 'WR' })],
      ['P3', synthetic('Flex Back', ['RB'], { projectedPoints: 9, selectedSlot: 'W/R/T' })],
      ['P4', synthetic('Bench Wide', ['WR'], { projectedPoints: 8.5, selectedSlot: 'BN' })],
      ['P5', synthetic('Locked Wide', ['WR'], { projectedPoints: 9.9, selectedSlot: 'BN', slotLocked: true })],
      ['P6', synthetic('Unprojected', ['WR'], { selectedSlot: 'BN' })],
      ['P7', synthetic('Q Back', ['RB'], { projectedPoints: 3, selectedSlot: 'BN', status: 'Q' })],
    ])
    const lineup = optimizeLineup(players, league, 3)
    expect(lineup.map(item => item.player)).toEqual(['P1', 'P2', 'P3'])
    expect(closePairs(players, lineup, 3, 2, 5)).toEqual([
      { id: 'C1', starter: 'P3', bench: 'P4', slot: 'W/R/T', why: 'projection' },
      { id: 'C2', starter: 'P2', bench: 'P4', slot: 'WR', why: 'projection' },
    ])
  })
})

describe('weak positions and the waiver shortlist', () => {
  it('scores empty slots, uncertain starters, and unavailable Yahoo starters per base position', () => {
    expect(basePositions(slots)).toEqual(['QB', 'RB', 'WR', 'TE', 'K', 'DEF'])
    const needs = positionNeeds(fixture, code, slots, 3)
    expect(needs.filter(item => item.need > 0)).toEqual([{ position: 'WR', need: 1, reasons: ['Zay Flowers is Q'] }])
    const players = new Map([
      ['P1', synthetic('Out Passer', ['QB'], { status: 'O', selectedSlot: 'QB' })],
      ['P2', synthetic('Wide', ['WR'], { selectedSlot: 'WR', projectedPoints: 4 })],
      ['P3', synthetic('Locked Out', ['WR'], { status: 'O', selectedSlot: 'WR', slotLocked: true })],
    ])
    const lineup = optimizeLineup(players, league, 3)
    const scored = positionNeeds(players, lineup, league, 3)
    expect(scored).toEqual([
      { position: 'QB', need: 3, reasons: ['empty QB slots: 1', 'Yahoo starter Out Passer is Yahoo status O'] },
      { position: 'WR', need: 0, reasons: [] },
    ])
  })

  it('shortlists positive net values by position, best first, and names a free-agent fallback for a claim', () => {
    const entry = (name: string, position: string, net: number, extra: Partial<PoolEntry['player']> = {}, gain = net): PoolEntry => {
      const player = synthetic(name, [position], extra)
      return { position, player, weeks: [player], value: { gain, net, perWeek: [net] } }
    }
    const pool = [
      entry('Claim Wide', 'WR', 3, { ownershipType: 'waivers' }), entry('Free Wide', 'WR', 2, { ownershipType: 'freeagents' }),
      entry('Owned Wide', 'WR', 2, { percentOwned: 40 }), entry('Owned Two', 'WR', 2, { percentOwned: 10 }), entry('Ranked Wide', 'WR', 2, { rank: 5 }), entry('Gainer Wide', 'WR', 2, {}, 3),
      entry('Kicker', 'K', 1), entry('Back', 'RB', 4, { ownershipType: 'freeagents' }), entry('Useless', 'TE', 0),
    ]
    const shortlist = waiverShortlist(pool, { positions: 2, candidates: 3 })
    expect(shortlist.positions).toEqual(['RB', 'WR'])
    expect(shortlist.candidates.map(item => `${item.id} ${item.player.name}`))
      .toEqual(['W1 Back', 'W2 Claim Wide', 'W3 Gainer Wide', 'W4 Ranked Wide'])
    expect(acquisition(pool[0]!.player)).toBe('claim')
    expect(acquisition(pool[1]!.player)).toBe('free agent')
    expect(freeAgentFallback(pool, pool[0]!, new Set())?.player.name).toBe('Gainer Wide')
    expect(freeAgentFallback(pool, pool[0]!, new Set(pool.slice(1, 6).map(item => item.player.key)))).toBeUndefined()
    expect(waiverShortlist([], { positions: 2, candidates: 3 })).toEqual({ positions: [], candidates: [] })
  })
})
