import { describe, expect, it } from 'vitest'
import type { ModelCall } from '../src/answers.ts'
import { reconcileCalls } from '../src/calls.ts'
import { optimizeLineup } from '../src/lineup.ts'
import { lockedRoster, rosterIds, synthetic, yahoo } from './support.ts'

const slots = yahoo.settings.rosterSlots
const fixture = new Map(yahoo.roster.players.map((player, index) => [rosterIds[index]!, player]))
const code = optimizeLineup(fixture, slots, 3)

function calls(entries: Record<string, ModelCall['call']>): Map<string, ModelCall> {
  return new Map(Object.entries(entries).map(([id, call]) => [id, { call, reason: `Model reason for ${id}.`, sources: [] }]))
}

describe('model calls against the code lineup', () => {
  it('keeps code defaults with plain reasons when the model gave no valid call', () => {
    const result = reconcileCalls(fixture, slots, 3, code, new Map())
    expect(result.lineup).toEqual(code)
    expect(result.calls.get('P7')).toEqual({ call: 'FLEX', reason: 'Starts at W/R/T; no projection.', sources: [],
      origin: 'default' })
    expect(result.calls.get('P9')).toMatchObject({ call: 'HOLD', origin: 'default' })
  })

  it('swaps a benched starter for a started bench player and labels starters by their final slot', () => {
    const result = reconcileCalls(fixture, slots, 3, code, calls({ P5: 'SIT', P8: 'START', P7: 'START', P10: 'HOLD' }))
    expect(result.lineup.find(item => item.player === 'P8')?.slot).toBe('WR')
    expect(result.lineup.some(item => item.player === 'P5')).toBe(false)
    expect(result.calls.get('P5')).toEqual({ call: 'SIT', reason: 'Model reason for P5.', sources: [], origin: 'model' })
    expect(result.calls.get('P8')).toMatchObject({ call: 'START', origin: 'model' })
    expect(result.calls.get('P7')).toMatchObject({ call: 'FLEX', origin: 'model' })
    expect(result.calls.get('P10')).toMatchObject({ call: 'HOLD', origin: 'model' })
  })

  it('pairs swaps one at a time when the full set of changes cannot fill the lineup', () => {
    const result = reconcileCalls(fixture, slots, 3, code, calls({ P5: 'SIT', P4: 'SIT', P8: 'START' }))
    expect(result.lineup.find(item => item.player === 'P8')?.slot).toBe('WR')
    expect(result.calls.get('P5')).toMatchObject({ call: 'SIT', origin: 'model' })
    expect(result.calls.get('P4')).toMatchObject({ call: 'START', origin: 'overridden', note: 'no legal lineup swap honors it',
      reason: 'Starts at WR; no projection.' })
    const second = reconcileCalls(fixture, slots, 3, code, calls({ P14: 'SIT', P5: 'SIT', P8: 'START' }))
    expect(second.calls.get('P14')).toMatchObject({ call: 'START', origin: 'overridden', note: 'no legal lineup swap honors it' })
    expect(second.calls.get('P5')).toMatchObject({ call: 'SIT', origin: 'model' })
    const lone = reconcileCalls(fixture, slots, 3, code, calls({ P8: 'START' }))
    expect(lone.lineup).toEqual(code)
    expect(lone.calls.get('P8')).toMatchObject({ call: 'SIT', origin: 'overridden', note: 'no legal lineup swap honors it' })
  })

  it('rejects starts of unavailable players, impossible flex calls, and moves of locked players', () => {
    const locked = new Map(lockedRoster([3, 9]).players.map((player, index) => [rosterIds[index]!, player]))
    const lockedCode = optimizeLineup(locked, slots, 3)
    const result = reconcileCalls(locked, slots, 3, lockedCode, calls({ P4: 'SIT', P10: 'START', P9: 'START', P1: 'FLEX', P11: 'HOLD' }))
    expect(result.lineup).toEqual(lockedCode)
    expect(result.calls.get('P4')).toMatchObject({ call: 'START', origin: 'overridden',
      note: 'Yahoo has locked his slot because his game has started' })
    expect(result.calls.get('P10')).toMatchObject({ call: 'SIT', origin: 'overridden',
      note: 'Yahoo has locked his slot because his game has started' })
    expect(result.calls.get('P9')).toMatchObject({ call: 'HOLD', origin: 'overridden', note: 'he cannot start while Yahoo status O' })
    expect(result.calls.get('P1')).toMatchObject({ call: 'START', origin: 'overridden', note: 'no flex slot in this league accepts him' })
    expect(result.calls.get('P11')).toMatchObject({ call: 'HOLD', origin: 'model' })
    const unavailableLocked = new Map([['P1', synthetic('Locked Out', ['QB'], { selectedSlot: 'QB', slotLocked: true, status: 'O' })]])
    const qb = [{ position: 'QB', count: 1, starting: true }]
    const kept = reconcileCalls(unavailableLocked, qb, 3, optimizeLineup(unavailableLocked, qb, 3), calls({ P1: 'START' }))
    expect(kept.calls.get('P1')).toMatchObject({ call: 'START', origin: 'model' })
    const thin = new Map([['P1', synthetic('Only Kicker', ['K'], { selectedSlot: 'K' })], ['P2', synthetic('Spare Kicker', ['K'])]])
    const twoKickers = [{ position: 'K', count: 1, starting: true }, { position: 'QB', count: 1, starting: true }]
    const swapped = reconcileCalls(thin, twoKickers, 3, optimizeLineup(thin, twoKickers, 3), calls({ P1: 'SIT', P2: 'START' }))
    expect(swapped.lineup).toEqual([{ slot: 'K', player: 'P2' }, { slot: 'QB', player: undefined }])
  })
})
