import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PlayerKey } from '@deepseek-ai/dsh-fantasy'
import type { FantasyPlayer } from '@deepseek-ai/dsh-fantasy/types'
import { normalizeName, parseRows, ProjectionIndex, translate, type SleeperRow } from '../src/sleeper.ts'

/** 38 trimmed rows of Sleeper's week 5 projections, including kickers, defenses, and punctuated names. */
const week5: unknown = JSON.parse(readFileSync(new URL('fixtures/projections-week5.json', import.meta.url), 'utf8'))

function player(name: string, nflTeam: string | undefined, positions: string[]): FantasyPlayer {
  return { key: PlayerKey(`470.p.${name.length}`), name, nflTeam, positions }
}

function row(name: string, team: string, position: string, stats: Record<string, number>, positions = [position]): SleeperRow {
  return { name, team, position, positions, stats }
}

describe('parseRows', () => {
  it('keeps valid rows with uppercase teams and positions and numeric stats only', () => {
    const rows = parseRows(week5)
    expect(rows).toHaveLength(38)
    expect(rows[0]).toMatchObject({ name: 'Josh Allen', position: 'QB', positions: ['QB'], team: 'BUF' })
    expect(parseRows([
      { team: null, player: { first_name: ' Tre\' ', last_name: 'Harris', position: 'wr', team: 'lac', fantasy_positions: ['WR', 'rb', 7] },
        stats: { rec: 3, note: 'x', bad: Number.NaN } },
    ])).toEqual([{ name: 'Tre\' Harris', position: 'WR', positions: ['WR', 'RB'], team: 'LAC', stats: { rec: 3 } }])
  })

  it('skips malformed rows and refuses a body that is not an array', () => {
    expect(parseRows([
      null, [], { player: null, stats: {} }, { player: {}, stats: null },
      { team: 'BUF', player: { first_name: '', last_name: 'Allen', position: 'QB' }, stats: {} },
      { team: 'BUF', player: { first_name: 'Josh', last_name: 3, position: 'QB' }, stats: {} },
      { team: 'BUF', player: { first_name: 'Josh', last_name: 'Allen' }, stats: {} },
      { player: { first_name: 'Josh', last_name: 'Allen', position: 'QB', team: null }, stats: {} },
      { team: 'BUF', player: { first_name: 'Josh', last_name: 'Allen', position: 'QB' }, stats: { pass_yd: 250 } },
    ])).toEqual([{ name: 'Josh Allen', position: 'QB', positions: ['QB'], team: 'BUF', stats: { pass_yd: 250 } }])
    expect(() => parseRows({ rows: [] })).toThrow('fantasy-projections-sleeper: projection response is not an array')
  })
})

describe('translate', () => {
  it('maps offensive and kicking keys to Yahoo stat ids, summing returns and two-point conversions', () => {
    expect(translate(row('A', 'BUF', 'WR', {
      pass_yd: 1, pass_td: 2, pass_int: 3, rush_att: 4, rush_yd: 5, rush_td: 6, rec: 7, rec_yd: 8, rec_td: 9, pr_td: 0.5, kr_td: 0.25,
      pass_2pt: 0.1, rush_2pt: 0.2, rec_2pt: 0.3, fum_lost: 10, rec_tgt: 11, pts_half_ppr: 99, sack: 4,
    }))).toEqual({ 4: 1, 5: 2, 6: 3, 8: 4, 9: 5, 10: 6, 11: 7, 12: 8, 13: 9, 15: 0.75, 16: expect.closeTo(0.6, 10) as number,
      18: 10, 78: 11 })
    expect(translate(row('K', 'DAL', 'K', {
      fgm_0_19: 1, fgm_20_29: 2, fgm_30_39: 3, fgm_40_49: 4, fgm_50p: 5, fgmiss_0_19: 6, fgmiss_20_29: 7, fgmiss_30_39: 8,
      fgmiss_40_49: 9, fgmiss_50p: 10, xpm: 11, xpmiss: 12,
    }))).toEqual({ 19: 1, 20: 2, 21: 3, 22: 4, 23: 5, 24: 6, 25: 7, 26: 8, 27: 9, 28: 10, 29: 11, 30: 12 })
  })

  it('maps defense keys, return touchdowns, and Sleeper tier flags', () => {
    const houston = parseRows(week5).find(item => item.position === 'DEF' && item.team === 'HOU') as SleeperRow
    expect(translate(houston)).toEqual({ 31: 22.75, 32: 2.68, 33: 0.89, 34: 0.61, 35: 0.22, 36: 0.06, 37: 0.06, 49: 0.06, 54: 1 })
    expect(translate(row('D', 'NE', 'DEF', { st_td: 0.1, pts_allow: 3, pts_allow_0: 0.2, pts_allow_1_6: 0.8, pr_td: 1 })))
      .toEqual({ 31: 3, 49: 0.1, 50: 0.2, 51: 0.8 })
  })

  it('derives the points-allowed tier from pts_allow when the row has no tier flag', () => {
    const tier = (allowed: number): Record<string, number> => translate(row('D', 'NE', 'DEF', { pts_allow: allowed }))
    expect([0, 0.5, 6.9, 7, 20.99, 21, 27.5, 34, 35, 52].map(allowed => Object.keys(tier(allowed)).filter(id => id !== '31')))
      .toEqual([['50'], ['50'], ['51'], ['52'], ['53'], ['54'], ['54'], ['55'], ['56'], ['56']])
    expect(translate(row('D', 'NE', 'DEF', {}))).toEqual({})
  })
})

describe('matching', () => {
  it('normalizes accents, punctuation, and suffixes', () => {
    expect(normalizeName('Amon-Ra St. Brown')).toBe('amon ra st brown')
    expect(normalizeName('Ja\'Marr Chase')).toBe('jamarr chase')
    expect(normalizeName('Kenneth Walker III')).toBe('kenneth walker')
    expect(normalizeName('Deebo Samuel Sr.')).toBe('deebo samuel')
    expect(normalizeName('C.J. Stroud')).toBe('cj stroud')
    expect(normalizeName('Ka’imi Fairbairn')).toBe('kaimi fairbairn')
    expect(normalizeName('Zoë Núñez Jr')).toBe('zoe nunez')
  })

  it('matches by name and team, defenses by team, and last name with team and position when unique', () => {
    const index = new ProjectionIndex(parseRows(week5))
    const name = (found: SleeperRow | undefined): string | undefined => found?.name
    expect(name(index.match(player('Amon-Ra St. Brown', 'Det', ['WR', 'W/R/T'])))).toBe('Amon-Ra St. Brown')
    expect(name(index.match(player('Ka\'imi Fairbairn', 'Hou', ['K'])))).toBe('Ka\'imi Fairbairn')
    expect(name(index.match(player('Texans', 'Hou', ['DEF'])))).toBe('Houston Texans')
    expect(name(index.match(player('Chig Flowers', 'Bal', ['WR'])))).toBe('Zay Flowers')
    expect(index.match(player('Chig Flowers', 'Bal', ['RB']))).toBeUndefined()
    expect(index.match(player('Josh Allen', undefined, ['QB']))).toBeUndefined()
    expect(index.match(player('Bears', 'Chi', ['DEF']))).toBeUndefined()
  })

  it('refuses ambiguous candidates', () => {
    const index = new ProjectionIndex([
      row('Sam Smith', 'NE', 'WR', { rec: 1 }), row('Sam Smith', 'NE', 'WR', { rec: 2 }),
      row('Al Jones', 'NE', 'RB', { rec: 1 }, ['RB', 'WR']), row('Bo Jones', 'NE', 'WR', { rec: 1 }),
      row('NE', 'NE', 'DEF', {}), row('NE', 'NE', 'DEF', {}),
    ])
    expect(index.match(player('Sam Smith', 'NE', ['WR']))).toBeUndefined()
    expect(index.match(player('Cy Jones', 'NE', ['WR']))).toBeUndefined()
    expect(index.match(player('Cy Jones', 'NE', ['RB']))?.name).toBe('Al Jones')
    expect(index.match(player('Patriots', 'NE', ['DEF']))).toBeUndefined()
  })
})
