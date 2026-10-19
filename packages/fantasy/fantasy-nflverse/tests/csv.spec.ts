import { expect, it } from 'vitest'
import { easternKickoff, yahooTeam } from '../src/index.ts'

it('converts US Eastern kickoffs on both sides of each daylight-saving change', () => {
  expect(easternKickoff('2026-03-08', '13:00')).toBe('2026-03-08T17:00:00.000Z')
  expect(easternKickoff('2026-03-07', '13:00')).toBe('2026-03-07T18:00:00.000Z')
  expect(easternKickoff('2026-11-01', '13:00')).toBe('2026-11-01T18:00:00.000Z')
  expect(easternKickoff('2026-10-31', '23:59')).toBe('2026-11-01T03:59:00.000Z')
  expect(easternKickoff('2026-11-01', '1:00')).toBeUndefined()
})

it('writes the Rams as LAR and uppercases other teams', () => {
  expect([yahooTeam('LA'), yahooTeam('la'), yahooTeam('Lac'), yahooTeam('JAX')]).toEqual(['LAR', 'LAR', 'LAC', 'JAX'])
})
