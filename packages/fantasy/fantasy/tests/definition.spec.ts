import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FantasyNflService, FantasyProjectionService, FantasyService, PlayerKey, normalizePlayerName } from '../src/index.ts'

describe('FantasyNflService', () => {
  it('refuses direct construction of the abstract definition', () => {
    expect(() => { Reflect.construct(FantasyNflService, [new Context()]) }).toThrow('load a fantasy NFL data provider, not the abstract definition')
  })

  it('registers a concrete provider as fantasyNfl', () => {
    class Provider extends FantasyNflService {
      games() { return Promise.resolve([]) }
      usage() { return Promise.resolve(new Map()) }
    }
    const ctx = new Context()
    expect(new Provider(ctx)).toBeInstanceOf(FantasyNflService)
  })
})

describe('definition construction', () => {
  it('refuses the abstract league definition and builds a concrete projection provider', () => {
    expect(() => { Reflect.construct(FantasyService, [new Context()]) }).toThrow('load a fantasy provider, not the abstract definition')
    class Projections extends FantasyProjectionService {
      project() { return Promise.resolve(new Map()) }
    }
    expect(new Projections(new Context())).toBeInstanceOf(FantasyProjectionService)
  })

  it('rejects a malformed player key', () => {
    expect(PlayerKey('470.p.1')).toBe('470.p.1')
    expect(() => PlayerKey('470.t.1')).toThrow('invalid fantasy player key')
  })
})

describe('normalizePlayerName', () => {
  it('drops generational suffixes and periods', () => {
    expect(normalizePlayerName('Omar Cooper Jr.')).toBe('omar cooper')
    expect(normalizePlayerName('Marvin Harrison Sr')).toBe('marvin harrison')
    expect(normalizePlayerName('Michael Penix II')).toBe('michael penix')
    expect(normalizePlayerName('Kenneth Walker III')).toBe('kenneth walker')
    expect(normalizePlayerName('A.J. Brown')).toBe('aj brown')
  })

  it('removes apostrophes without splitting the word', () => {
    expect(normalizePlayerName("Wan'Dale Robinson")).toBe('wandale robinson')
    expect(normalizePlayerName('Ja’Marr Chase')).toBe('jamarr chase')
    expect(normalizePlayerName('D`Andre Swift')).toBe('dandre swift')
  })

  it('folds accents to ASCII letters', () => {
    expect(normalizePlayerName('Tomás Ölzen')).toBe('tomas olzen')
  })

  it('splits hyphens and other separators into single spaces', () => {
    expect(normalizePlayerName('Amon-Ra St. Brown')).toBe('amon ra st brown')
    expect(normalizePlayerName('  Jaxon   Smith-Njigba ')).toBe('jaxon smith njigba')
    expect(normalizePlayerName('')).toBe('')
  })
})
