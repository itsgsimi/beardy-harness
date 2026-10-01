import { describe, expect, it } from 'vitest'
import { reconcileCalls } from '../src/calls.ts'
import { closePairs } from '../src/facts.ts'
import { optimizeLineup } from '../src/lineup.ts'
import type { Evidence } from '../src/news.ts'
import { CUT_NOTICE, formatInstant, renderReport, type ReportView } from '../src/render.ts'
import { WEDNESDAY_WEEK_3, lockedRoster, playerPage, rosterIds, synthetic, yahoo } from './support.ts'

const slots = yahoo.settings.rosterSlots
const players = new Map(yahoo.roster.players.map((player, index) => [rosterIds[index]!, player]))
const evidence: Evidence[] = rosterIds.slice(1).map((id, index) => ({ id: index + 2, url: playerPage(index + 1).url,
  title: index === 0 ? 'Gibbs [news] <update>' : `Player ${index + 2}`, players: [id], text: playerPage(index + 1).text }))
const code = optimizeLineup(players, slots, 3)
const model = new Map([
  ['P5', { call: 'SIT' as const, reason: 'Limited with a hamstring injury.', sources: [5] }],
  ['P8', { call: 'START' as const, reason: 'Practiced fully on Wednesday.', sources: [8] }],
])
const { lineup, calls } = reconcileCalls(players, slots, 3, code, model)
const [ours, opponent] = yahoo.matchups[0]!.teams as [typeof yahoo.matchups[0]['teams'][0], typeof yahoo.matchups[0]['teams'][0]]

const view: ReportView = {
  teamName: 'The Googies', season: '2026', week: 3, mode: 'thursday', firedAt: WEDNESDAY_WEEK_3, timezone: 'America/Phoenix',
  players, slots, matchup: { ours, opponent }, summary: 'The Googies start Addison for Flowers this week.', lineup, calls,
  comparisons: closePairs(players, code, 3, 2, 3).map(pair => ({ pair, text: 'Addison practiced fully; Flowers did not.', sources: [5, 8] })),
  waivers: [{ candidate: { id: 'W1', position: 'WR', player: yahoo.available[7]! }, reason: 'A healthy fill-in.' }],
  caveats: ['No current news page was admitted for Trevor Lawrence; their calls rest on Yahoo data.'], evidence,
}

describe('report rendering', () => {
  it('leads with the matchup and summary, then the lineup, calls, close calls, waivers, caveats, and cited sources', () => {
    const text = renderReport(view, 19_000)
    expect(formatInstant(WEDNESDAY_WEEK_3, 'America/Phoenix')).toBe('Wed, Sep 23, 2:00 PM MST')
    expect(text.startsWith('# The Googies · 2026 week 3 Thursday update\n**Wed, Sep 23, 2:00 PM MST · Yahoo roster and slots, weekly projections**'))
      .toBe(true)
    expect(text).toContain('**Matchup:** The Googies 116.1 vs Team 5 94.6 projected · Yahoo win probability 59%')
    expect(text).not.toContain('By slot')
    expect(text).toContain('## Summary\nThe Googies start Addison for Flowers this week.\n\n## Lineup\n'
      + 'Changes from your Yahoo lineup: start Jordan Addison, bench Zay Flowers.')
    expect(text).toContain('- **WR** Jordan Addison · Min · proj n/a · **start** (Yahoo BN)')
    expect(text).toContain('Bench: Zay Flowers (Q), Jayden Daniels (O), J.K. Dobbins, Nico Collins (O), Bhayshul Tuten, Isaiah Likely')
    expect(text).toContain('**Zay Flowers — SIT** · WR · Bal · bye 13\nLimited with a hamstring injury. [5](<https://news.example/p5>)')
    expect(text).toContain('**Trevor Lawrence — START** · QB · Jax · bye 7 · code reason\nStarts at QB; no projection.')
    expect(text).toContain('**Zay Flowers or Jordan Addison** (WR)\nAddison practiced fully; Flowers did not. '
      + '[5](<https://news.example/p5>) [8](<https://news.example/p8>)')
    expect(text).toContain('## Waiver ideas\n- **Olamide Zaccheaus** · WR · Atl — A healthy fill-in.')
    expect(text).toContain('- No current news page was admitted for Trevor Lawrence; their calls rest on Yahoo data.\n'
      + '- Recommendations only: check final injury reports and Yahoo lineup locks before changing your lineup.')
    expect(text).toContain('## Sources\n[5 · Player 5](<https://news.example/p5>)\n[8 · Player 8](<https://news.example/p8>)\n')
  })

  it('drops bench reasons when the full report is too long, then cuts at a line with a notice', () => {
    const full = renderReport(view, 19_000)
    const compact = renderReport(view, full.length - 1)
    expect(compact).not.toContain('Limited with a hamstring injury.')
    expect(compact).toContain('Practiced fully on Wednesday.')
    const cut = renderReport(view, 900)
    expect(cut.length).toBeLessThanOrEqual(900)
    expect(cut.endsWith(`\n${CUT_NOTICE}\n`)).toBe(true)
  })

  it('shows slot projections, empty slots, locks, owned share, and omits absent sections', () => {
    const locked = new Map(lockedRoster([3]).players.map((player, index) => [rosterIds[index]!, player]))
    const lockedCalls = reconcileCalls(locked, slots, 3, optimizeLineup(locked, slots, 3), new Map()).calls
    const text = renderReport({ ...view, players: locked, calls: lockedCalls, lineup: [...optimizeLineup(locked, slots, 3).slice(0, 8),
      { slot: 'DEF', player: undefined }], comparison: [{ slot: 'QB', ours: 18.25, theirs: 20 }], comparisons: [],
    waivers: [{ candidate: { id: 'W1', position: 'RB', player: synthetic('Owned Back', ['RB'], { percentOwned: 12 }) }, reason: 'Depth.' }],
    matchup: { ours: { ...ours, winProbability: undefined }, opponent }, caveats: [], evidence: [] }, 19_000)
    expect(text).toContain('**Matchup:** The Googies 116.1 vs Team 5 94.6 projected\nBy slot (yours vs theirs): QB 18.3–20.0\n')
    expect(text).toContain('- **WR** Parker Washington · Jax · proj n/a · locked')
    expect(text).toContain('- **DEF** — empty: no eligible player can play')
    expect(text).toContain('Bench: Jordan Addison, Jayden Daniels (O), J.K. Dobbins, Nico Collins (O), Bhayshul Tuten, Isaiah Likely, Steelers')
    expect(text).toContain('- **Owned Back** · RB · 12% owned — Depth.')
    expect(text).not.toContain('## Close calls')
    expect(text).not.toContain('## Sources')
    const { matchup: _matchup, ...unmatched } = view
    const bare = renderReport({ ...unmatched, waivers: [], comparisons: [],
      players: new Map([['P1', synthetic('Locked Bench', ['QB'], { slotLocked: true, selectedSlot: 'BN', status: 'O' })]]),
      lineup: [{ slot: 'QB', player: undefined }],
      calls: new Map([['P1', { call: 'HOLD' as const, reason: 'Benched.', sources: [], origin: 'default' as const }]]) }, 19_000)
    expect(bare).not.toContain('**Matchup:**')
    expect(bare).not.toContain('## Waiver ideas')
    expect(bare).toContain('Bench: Locked Bench (O) (locked)')
    expect(bare).toContain('**Locked Bench — HOLD** · QB · code reason\nBenched.')
    const full = renderReport({ ...unmatched, waivers: [], comparisons: [],
      players: new Map([['P1', synthetic('New Starter', ['QB'], { status: 'Q' })]]), lineup: [{ slot: 'QB', player: 'P1' }],
      calls: new Map([['P1', { call: 'START' as const, reason: 'Starts.', sources: [], origin: 'model' as const }]]) }, 19_000)
    expect(full).toContain('- **QB** New Starter · proj n/a · Yahoo Q · **start** (Yahoo BN)')
    expect(full).not.toContain('Bench:')
  })
})
