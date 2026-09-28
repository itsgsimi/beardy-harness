import { describe, expect, it } from 'vitest'
import type { FantasyPlayer, FantasyRosterSlot } from '@deepseek-ai/dsh-fantasy/types'
import { PlayerKey } from '@deepseek-ai/dsh-fantasy'
import { eligibleFor, lineupChanges, lineupErrors, lockedPlayers, unavailableReason, type LineupAssignment } from '../src/lineup.ts'
import { lockedRoster, rosterIds, yahoo } from './support.ts'

const players = new Map(yahoo.roster.players.map((player, index) => [rosterIds[index]!, player]))
const slots = yahoo.settings.rosterSlots
/** Yahoo's own current starters in the anonymized week 3 capture. */
const current: LineupAssignment[] = [...players].filter(([, player]) => !['BN', 'IR'].includes(player.selectedSlot ?? 'BN'))
  .map(([id, player]) => ({ player: id, slot: player.selectedSlot as string }))

describe('Yahoo lineup legality', () => {
  it('accepts the live nine-slot starting lineup of the real league settings', () => {
    expect(slots.filter(slot => slot.starting).map(slot => `${slot.position}x${slot.count}`))
      .toEqual(['QBx1', 'RBx2', 'WRx2', 'TEx1', 'W/R/Tx1', 'Kx1', 'DEFx1'])
    expect(current).toHaveLength(9)
    expect(lineupErrors(current, players, slots, 3)).toEqual([])
    expect(lineupChanges(current, players, slots)).toEqual({ start: [], bench: [] })
  })

  it('rejects ineligible, duplicate, unknown, bench, missing, and surplus assignments', () => {
    const swapFlex = current.map(item => item.slot === 'W/R/T' ? { player: 'P1', slot: 'W/R/T' } : item)
    expect(lineupErrors(swapFlex, players, slots, 3)).toEqual([
      'lineup: P1 starts more than once', 'lineup: P1 (Trevor Lawrence) is not eligible for W/R/T',
    ])
    const bench = [...current.filter(item => item.slot !== 'K'), { player: 'P13', slot: 'BN' }, { player: 'P99', slot: 'k' }]
    expect(lineupErrors(bench, players, slots, 3)).toEqual([
      'lineup: BN is not a starting slot in this league', 'lineup: P99 is not on the roster',
    ])
    const surplus = [...current, { player: 'P8', slot: 'WR' }]
    expect(lineupErrors(surplus, players, slots, 3)).toEqual(['lineup: WR needs 2 starter(s); the draft has 3'])
    expect(lineupErrors(current.filter(item => item.slot !== 'DEF'), players, slots, 3))
      .toEqual(['lineup: DEF needs 1 starter(s); the draft has 0'])
    expect(lineupErrors(current, players, [], 3)).toEqual(['Yahoo returned no starting slots for this league'])
  })

  it('refuses starters on bye or listed out by Yahoo and swaps them from the current lineup', () => {
    const daniels = current.map(item => item.slot === 'QB' ? { player: 'P9', slot: 'QB' } : item)
    expect(lineupErrors(daniels, players, slots, 3)).toEqual(['lineup: P9 cannot start because Jayden Daniels has Yahoo status O'])
    expect(lineupErrors(current, players, slots, 7)).toEqual([
      'lineup: P1 cannot start because Trevor Lawrence is on bye in week 7',
      'lineup: P3 cannot start because Omarion Hampton is on bye in week 7',
      'lineup: P4 cannot start because Parker Washington is on bye in week 7',
    ])
    const changes = lineupChanges(daniels, players, slots)
    expect(changes.start.map(player => player.name)).toEqual(['Jayden Daniels'])
    expect(changes.bench.map(player => player.name)).toEqual(['Trevor Lawrence'])
    const unslotted = new Map(players)
    unslotted.set('P1', { ...players.get('P1')!, selectedSlot: undefined })
    const fromUnslotted = lineupChanges([...current, { player: 'P99', slot: 'WR' }], unslotted, slots)
    expect(fromUnslotted.start.map(player => player.name)).toEqual(['Trevor Lawrence'])
    expect(fromUnslotted.bench).toEqual([])
  })

  it('reads flex eligibility from Yahoo positions or from the flex members, and ignores questionable status', () => {
    const plain: FantasyPlayer = { key: PlayerKey('470.p.1'), name: 'Plain Receiver', positions: ['WR'], status: 'Q', byeWeek: 9 }
    expect(eligibleFor(plain, 'W/R/T')).toBe(true)
    expect(eligibleFor(plain, 'Q/W/R/T')).toBe(true)
    expect(eligibleFor(plain, 'TE')).toBe(false)
    expect(eligibleFor(plain, 'IDP')).toBe(false)
    expect(unavailableReason(plain, 3)).toBeUndefined()
    expect(unavailableReason({ ...plain, status: 'susp' }, 3)).toBe('Plain Receiver has Yahoo status susp')
    const superflex: FantasyRosterSlot[] = [{ position: 'Q/W/R/T', count: 1, starting: true }, { position: 'BN', count: 1, starting: false }]
    expect(lineupErrors([{ player: 'P1', slot: 'q/w/r/t' }], players, superflex, 3)).toEqual([])
  })
})

describe('Yahoo slot locks on Sunday', () => {
  /** Sunday of week 3 after Thursday night: Parker Washington (starting WR) and J.K. Dobbins (bench) have played. */
  const sunday = new Map(lockedRoster([3, 9]).players.map((player, index) => [rosterIds[index]!, player]))

  it('keeps a locked starter in his Yahoo slot and a locked bench player out of the lineup', () => {
    expect(lockedPlayers(sunday).map(player => [player.name, player.selectedSlot])).toEqual([['Parker Washington', 'WR'], ['J.K. Dobbins', 'BN']])
    expect(lockedPlayers(players)).toEqual([])
    expect(lineupErrors(current, sunday, slots, 3)).toEqual([])
    const benchWashington = current.map(item => item.player === 'P4' ? { player: 'P8', slot: 'WR' } : item)
    expect(lineupErrors(benchWashington, players, slots, 3)).toEqual([])
    expect(lineupErrors(benchWashington, sunday, slots, 3)).toEqual([
      'lineup: P4 (Parker Washington) is locked in WR by Yahoo because his game has started; keep him in WR',
    ])
    const flexWashington = current.map(item => item.player === 'P4' ? { player: 'P8', slot: 'WR' }
      : item.player === 'P7' ? { player: 'P4', slot: 'W/R/T' } : item)
    expect(lineupErrors(flexWashington, sunday, slots, 3)).toEqual([
      'lineup: P4 (Parker Washington) is locked in WR by Yahoo because his game has started; keep him in WR',
    ])
    const startDobbins = current.map(item => item.slot === 'W/R/T' ? { player: 'P10', slot: 'W/R/T' } : item)
    expect(lineupErrors(startDobbins, sunday, slots, 3)).toEqual([
      'lineup: P10 (J.K. Dobbins) is locked on BN by Yahoo because his game has started; he cannot start',
    ])
  })

  it('exempts a locked starter from the availability check and treats a locked player without a slot as benched', () => {
    const hurt = new Map(sunday)
    hurt.set('P4', { ...sunday.get('P4')!, status: 'O' })
    expect(lineupErrors(current, hurt, slots, 3)).toEqual([])
    expect(lineupErrors(current, new Map(hurt).set('P4', { ...hurt.get('P4')!, slotLocked: false }), slots, 3))
      .toEqual(['lineup: P4 cannot start because Parker Washington has Yahoo status O'])
    const unslotted = new Map(sunday).set('P10', { ...sunday.get('P10')!, selectedSlot: undefined })
    expect(lineupErrors(current.map(item => item.slot === 'W/R/T' ? { player: 'P10', slot: 'W/R/T' } : item), unslotted, slots, 3))
      .toEqual(['lineup: P10 (J.K. Dobbins) is locked on BN by Yahoo because his game has started; he cannot start'])
  })
})
