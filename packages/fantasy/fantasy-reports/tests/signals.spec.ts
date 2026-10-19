import { describe, expect, it } from 'vitest'
import { claimTiming, gameDay, weekDeadlines } from '../src/deadlines.ts'
import { changesSince, parseReportFacts, type ReportFacts } from '../src/since.ts'
import { articleMentions, gameFor, recentForm } from '../src/signals.ts'
import { synthetic, yahoo } from './support.ts'

describe('recent form', () => {
  it('averages completed weeks, skips the bye week, and flags form against the projection by the gap', () => {
    const douglas = synthetic('Hot Wide', ['WR'], { projectedPoints: 3.6, byeWeek: 5 })
    expect(recentForm(douglas, new Map([[6, 16.1], [4, 20.5], [5, 0]]), 4)).toEqual({
      points: [{ week: 4, points: 20.5 }, { week: 6, points: 16.1 }], average: 18.3, flag: 'hot' })
    expect(recentForm(synthetic('Cold End', ['TE'], { projectedPoints: 9 }), new Map([[4, 5.6]]), 3)).toMatchObject({ flag: 'cold' })
    expect(recentForm(synthetic('Steady', ['TE'], { projectedPoints: 9 }), new Map([[4, 8]]), 3)).toEqual({
      points: [{ week: 4, points: 8 }], average: 8 })
    expect(recentForm(synthetic('Unprojected', ['TE']), new Map([[4, 8]]), 3)).not.toHaveProperty('flag')
    expect(recentForm(douglas, new Map(), 4)).toEqual({ points: [] })
  })
})

describe('NFL games', () => {
  const games = [
    { week: 7, kickoff: '2026-10-23T00:15:00Z', home: 'LAR', away: 'jax', homeSpread: 3.5, total: 47.5 },
    { week: 7, kickoff: '2026-10-25T13:30:00Z', home: 'NYG', away: 'HOU' },
    { week: 7, kickoff: '2026-10-25T17:00:00Z', home: 'MIN', away: 'DET', homeSpread: -3, total: 51 },
  ]

  it('finds a team\'s opponent, side, kickoff, and implied total case-insensitively', () => {
    expect(gameFor(games, 'Jax')).toEqual({ opponent: 'LAR', home: false, kickoff: Date.parse('2026-10-23T00:15:00Z'), impliedTotal: 22 })
    expect(gameFor(games, 'LAR')).toMatchObject({ opponent: 'JAX', home: true, impliedTotal: 25.5 })
    expect(gameFor(games, 'Min')).toMatchObject({ impliedTotal: 24 })
    expect(gameFor(games, 'NYG')).toEqual({ opponent: 'HOU', home: true, kickoff: Date.parse('2026-10-25T13:30:00Z') })
    expect(gameFor(games, 'Pit')).toBeUndefined()
    expect(gameFor(games, undefined)).toBeUndefined()
  })

  it('calls out games before the first Sunday kickoff, including a Sunday morning game abroad, and the waiver period', () => {
    const deadlines = weekDeadlines(games, { ...yahoo.settings, waiverDays: 2 })
    expect(deadlines).toEqual({ early: [{ away: 'JAX', home: 'LAR', kickoff: Date.parse('2026-10-23T00:15:00Z') }],
      firstSunday: Date.parse('2026-10-25T13:30:00Z'), waiverDays: 2 })
    expect(gameDay(Date.parse('2026-10-23T00:15:00Z'))).toBe('Thursday')
    expect(claimTiming(deadlines)).toBe('submit now, before Yahoo processes claims; dropped players stay on waivers for 2 days')
    expect(claimTiming({ early: [], waiverDays: 1 })).toContain('for 1 day')
    expect(weekDeadlines(games.slice(0, 1), { ...yahoo.settings, waiverDays: undefined })).toEqual({ early: [] })
    expect(claimTiming({ early: [] })).toBe('submit now, before Yahoo processes claims')
  })
})

describe('article mentions', () => {
  it('counts distinct pages that name each player on normalized word boundaries', () => {
    const cooper = synthetic('Omar Cooper Jr.', ['WR'])
    const wandale = synthetic('Wan\'Dale Robinson', ['WR'])
    const cole = synthetic('Cole Kmet', ['TE'])
    const pages = ['Top adds: Omar Cooper, Wandale Robinson.', 'OMAR COOPER JR. is the add; Coleman Kmetz is not.', 'Nothing here.']
    expect([...articleMentions(pages, [cooper, wandale, cole, cooper, synthetic('Jr.', ['WR'])])])
      .toEqual([[cooper.key, 2], [wandale.key, 1]])
  })
})

describe('changes since the last report', () => {
  const earlier: ReportFacts = {
    roster: [{ key: 'k1', name: 'Zay Flowers' }, { key: 'k2', name: 'Nico Collins', status: 'Q' }, { key: 'k3', name: 'Cut Guy' },
      { key: 'k5', name: 'Healed Guy', status: 'D' }],
    moves: { ir: [], claims: ['k8'], adds: [] }, names: {},
  }

  it('lists status changes, roster changes, and moves the earlier report did not suggest', () => {
    const current: ReportFacts = {
      roster: [{ key: 'k1', name: 'Zay Flowers', status: 'Q' }, { key: 'k2', name: 'Nico Collins', status: 'O' },
        { key: 'k4', name: 'New Guy' }, { key: 'k5', name: 'Healed Guy' }],
      moves: { ir: ['k2'], claims: ['k8', 'k9'], adds: ['k7'] }, names: { k2: 'Nico Collins', k9: 'Omar Cooper Jr.' },
    }
    expect(changesSince(earlier, current)).toEqual(['Zay Flowers: Yahoo status none → Q', 'Nico Collins: Yahoo status Q → O',
      'Healed Guy: Yahoo status D → none',
      'New on the roster: New Guy', 'No longer on the roster: Cut Guy', 'New IR moves: Nico Collins', 'New waiver claims: Omar Cooper Jr.',
      'New free-agent adds: k7'])
    expect(changesSince(earlier, earlier)).toEqual([])
  })

  it('reads facts from report evidence, including evidence written before moves were recorded', () => {
    const evidence = JSON.stringify({ yahoo: { roster: { players: [{ key: 'k1', name: 'Zay Flowers', status: 'Q' }, { name: 'No Key' }, 7] } },
      moves: { ir: ['k2', 3], claims: [], adds: 'k3', names: { k2: 'Nico Collins', k4: 4 } } })
    expect(parseReportFacts(evidence)).toEqual({ roster: [{ key: 'k1', name: 'Zay Flowers', status: 'Q' }],
      moves: { ir: ['k2'], claims: [], adds: [] }, names: { k2: 'Nico Collins' } })
    expect(parseReportFacts(JSON.stringify({ yahoo: { roster: { players: [] } } })))
      .toEqual({ roster: [], moves: { ir: [], claims: [], adds: [] }, names: {} })
    expect(parseReportFacts(JSON.stringify({ yahoo: { roster: { players: [] } }, moves: { names: [] } })))
      .toMatchObject({ names: {} })
    expect(parseReportFacts('not json')).toBeUndefined()
    expect(parseReportFacts('[]')).toBeUndefined()
    expect(parseReportFacts(JSON.stringify({ yahoo: { roster: {} } }))).toBeUndefined()
  })
})
