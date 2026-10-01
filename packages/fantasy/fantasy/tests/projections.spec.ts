import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FantasyProjectionService, scoreStats } from '../src/index.ts'

describe('FantasyProjectionService', () => {
  it('refuses direct construction of the abstract definition', () => {
    expect(() => { Reflect.construct(FantasyProjectionService, [new Context()]) }).toThrow('load a fantasy projection provider, not the abstract definition')
  })
})

describe('scoreStats', () => {
  const scoring = [
    { id: '4', name: 'Pass Yds', value: 0.04 }, { id: '5', name: 'Pass TD', value: 4 }, { id: '8', name: 'Rush Att' },
    { id: '11', name: 'Rec', value: 0.5 }, { id: '18', name: 'Fum Lost', value: -2 },
  ]

  it('sums each scored stat times its value, rounded to hundredths', () => {
    expect(scoreStats({ 4: 251.24, 5: 1.55, 8: 7.56, 18: 0.19, 99: 50 }, scoring)).toBe(15.87)
    expect(scoreStats({ 11: 1 / 3 }, scoring)).toBe(0.17)
    expect(scoreStats({}, scoring)).toBe(0)
  })
})
