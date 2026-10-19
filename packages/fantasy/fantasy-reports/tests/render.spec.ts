import { describe, expect, it } from 'vitest'
import { reconcileCalls } from '../src/calls.ts'
import { weekDeadlines } from '../src/deadlines.ts'
import { closePairs, type PoolEntry, type WaiverCandidate } from '../src/facts.ts'
import { optimizeLineup } from '../src/lineup.ts'
import type { Evidence } from '../src/news.ts'
import { CUT_NOTICE, formatInstant, type MovesView, renderReport, type ReportView } from '../src/render.ts'
import { gameFor } from '../src/signals.ts'
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

/** Week 3 games: Baltimore plays Thursday night; the first Sunday kickoff is 1:00 PM Eastern. */
const games = [
  { week: 3, kickoff: '2026-09-25T00:15:00Z', home: 'BAL', away: 'DET', homeSpread: 3, total: 50 },
  { week: 3, kickoff: '2026-09-27T17:00:00Z', home: 'MIN', away: 'JAX' },
  { week: 3, kickoff: '2026-09-27T20:25:00Z', home: 'ATL', away: 'CHI', homeSpread: -2.5, total: 44 },
]
const deadlines = weekDeadlines(games, { ...yahoo.settings, waiverDays: 2 })

function candidate(id: string, position: string, player: PoolEntry['player'], net: number): WaiverCandidate {
  return { id, position, player, weeks: [player], value: { gain: net, net, perWeek: [net] } }
}
const claim = candidate('W1', 'WR', { ...yahoo.available[7]!, ownershipType: 'waivers' }, 3.25)
const fallback = candidate('W9', 'WR', synthetic('Fallback Wide', ['WR'], { ownershipType: 'freeagents' }), 1.5)
const add = candidate('W2', 'RB', synthetic('Free Back', ['RB'], { nflTeam: 'Chi', ownershipType: 'freeagents', percentOwned: 12 }), 2)
const kicker = candidate('W3', 'K', synthetic('Free Kicker', ['K'], { ownershipType: 'freeagents' }), 1)
const moves: MovesView = {
  enabled: true, irMoves: ['P9'], dropCosts: new Map([['P12', 0.25], ['P14', 0]]), waiverPriority: 4, teams: 10, faabBalance: 87,
  picks: [
    { candidate: claim, reason: 'Took over the slot role.', kind: 'claim', net: 3.25, weeks: 3, drop: 'P12', fallback },
    { candidate: add, reason: 'Goal-line back.', kind: 'free agent', net: 2, weeks: 3 },
    { candidate: kicker, reason: 'Dome kicker.', kind: 'free agent', net: 1, weeks: 3, drop: 'P14' },
  ],
}

const view: ReportView = {
  teamName: 'The Googies', season: '2026', week: 3, mode: 'thursday', firedAt: WEDNESDAY_WEEK_3, timezone: 'America/Phoenix',
  players, slots, matchup: { ours, opponent }, summary: 'The Googies start Addison for Flowers this week.', lineup, calls,
  comparisons: closePairs(players, code, 3, 2, 3).map(pair => ({ pair, text: 'Addison practiced fully; Flowers did not.', sources: [5, 8] })),
  moves, weeks: [3, 4, 5],
  byes: [{ week: 3, bye: [], empty: [] }, { week: 4, bye: ['P1', 'P9'], empty: ['QB'] }],
  chip: { id: 'P1', position: 'QB', healthy: 3, need: 2, average: 15.25 },
  form: new Map([[players.get('P2')!.key, { points: [{ week: 1, points: 20.5 }, { week: 2, points: 16.1 }], average: 18.3, flag: 'hot' as const }],
    [players.get('P3')!.key, { points: [{ week: 2, points: 9 }], average: 9 }]]),
  game: player => gameFor(games, player.nflTeam), deadlines,
  since: { mode: 'full', lines: ['Zay Flowers: Yahoo status none → Q'] },
  caveats: ['No current news page was admitted for Trevor Lawrence; their calls rest on Yahoo data.'], evidence,
}
const quiet: MovesView = { enabled: true, irMoves: [], picks: [], dropCosts: new Map() }

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
    expect(text).toContain('## Checklist\n1. Start Jordan Addison — before kickoff (Sun, Sep 27, 10:00 AM MST)\n'
      + '2. Bench Zay Flowers — before the **Thursday game** (Thu, Sep 24, 5:15 PM MST)\n'
      + '3. Move Jayden Daniels to IR — now, so his roster spot opens\n'
      + '4. Claim Olamide Zaccheaus, dropping Bhayshul Tuten — submit now, before Yahoo processes claims; dropped players stay on '
      + 'waivers for 2 days; if the claim fails, add Fallback Wide instead\n'
      + '5. Add Free Back — before kickoff (Sun, Sep 27, 1:25 PM MST)\n'
      + '6. Swap K: add Free Kicker, dropping Cairo Santos — before kickoff (Sun, Sep 27, 1:25 PM MST)\n'
      + '7. Set the final lineup before the first Sunday kickoff (Sun, Sep 27, 10:00 AM MST)\n\n**Matchup:**')
    expect(text).toContain('- **RB** Jahmyr Gibbs · Det · proj n/a · @ BAL Thu, Sep 24, 5:15 PM MST · implied 23.5 · recent 20.5, 16.1 '
      + '(avg 18.3, hot)')
    expect(text).toContain('- **RB** Omarion Hampton · LAC · proj n/a · recent 9.0 (avg 9.0)')
    expect(text).toContain('## Moves\nWaiver priority 4 of 10 · FAAB $87 · waiver period 2 days\n'
      + '- **Move Jayden Daniels to IR**: Yahoo lists him IR-eligible and an IR slot is empty.\n'
      + '- **Claim Olamide Zaccheaus** · WR · Atl · +3.3 pts/wk over 3 wk · drop Bhayshul Tuten · vs CHI Sun, Sep 27, 1:25 PM MST · '
      + 'implied 20.8 — Took over the slot role. If the claim fails, add Fallback Wide (free agent, +1.5 pts/wk).\n'
      + '- **Add Free Back** · RB · Chi · +2.0 pts/wk over 3 wk · open roster spot · 12% owned · @ ATL Sun, Sep 27, 1:25 PM MST · '
      + 'implied 23.3 — Goal-line back.\n'
      + 'Drops: Bhayshul Tuten (costs 0.3 pts/wk)\n'
      + '- **Swap K: add Free Kicker** · K · +1.0 pts/wk over 3 wk · drop Cairo Santos — Dome kicker.\n')
    expect(text).toContain('## Bye outlook\n- Week 3: no byes; every starting slot can be filled\n'
      + '- Week 4: on bye Trevor Lawrence, Jayden Daniels; nobody can fill QB\n\n'
      + '## Trade chip\n**Trevor Lawrence** (QB) — 3 healthy players at QB for 2 starting slots and a bye cover; averages 15.3 projected over weeks 3, 4, 5.')
    expect(text).toContain('## Since the full report\n- Zay Flowers: Yahoo status none → Q\n\n## Player calls')
    expect(text).toContain('- No current news page was admitted for Trevor Lawrence; their calls rest on Yahoo data.\n'
      + '- Recommendations only: check final injury reports and Yahoo lineup locks before changing your lineup.')
    expect(text).toContain('## Sources\n[5 · Player 5](<https://news.example/p5>)\n[8 · Player 8](<https://news.example/p8>)\n')
  })

  it('renders a claim without a fallback, a claimed swap, a priority without a team count, and a one-slot trade chip', () => {
    const { fallback: _fallback, ...withoutFallback } = moves.picks[0]!
    const { drop: _drop, ...withoutDrop } = moves.picks[2]!
    const { teams: _teams, faabBalance: _faab, ...countless } = moves
    const text = renderReport({ ...view, chip: { id: 'P1', position: 'QB', healthy: 3, need: 1, average: 15 },
      moves: { ...countless, irMoves: [],
        picks: [withoutFallback, { ...withoutDrop, kind: 'claim' }] } }, 19_000)
    expect(text).toContain('## Moves\nWaiver priority 4 · waiver period 2 days\n- **Claim Olamide Zaccheaus**')
    expect(text).toContain('implied 20.8 — Took over the slot role.\n')
    expect(text).toContain('4. Claim Free Kicker — submit now')
    expect(text).toContain('- **Swap K: claim Free Kicker** · K · +1.0 pts/wk over 3 wk · open roster spot — Dome kicker.')
    expect(text).toContain('for 1 starting slot and a bye cover')
  })

  it('drops bench reasons, then the outlook sections, when the report is too long, then cuts at a line with a notice', () => {
    const full = renderReport(view, 19_000)
    const compact = renderReport(view, full.length - 1)
    expect(compact).not.toContain('Limited with a hamstring injury.')
    expect(compact).toContain('Practiced fully on Wednesday.')
    expect(compact).toContain('## Trade chip')
    const minimal = renderReport(view, compact.length - 1)
    expect(minimal).not.toContain('## Bye outlook')
    expect(minimal).not.toContain('## Trade chip')
    expect(minimal).toContain('## Moves')
    expect(minimal.endsWith(`${CUT_NOTICE}\n`)).toBe(false)
    const cut = renderReport(view, 900)
    expect(cut.length).toBeLessThanOrEqual(900)
    expect(cut.endsWith(`\n${CUT_NOTICE}\n`)).toBe(true)
  })

  it('shows slot projections, empty slots, locks, owned share, and omits absent sections', () => {
    const locked = new Map(lockedRoster([3]).players.map((player, index) => [rosterIds[index]!, player]))
    const lockedCalls = reconcileCalls(locked, slots, 3, optimizeLineup(locked, slots, 3), new Map()).calls
    const text = renderReport({ ...view, players: locked, calls: lockedCalls, lineup: [...optimizeLineup(locked, slots, 3).slice(0, 8),
      { slot: 'DEF', player: undefined }], comparison: [{ slot: 'QB', ours: 18.25, theirs: 20 }], comparisons: [],
    moves: quiet, matchup: { ours: { ...ours, winProbability: undefined }, opponent }, caveats: [], evidence: [], game: () => undefined,
    since: { mode: 'thursday', lines: [] }, byes: [], form: new Map() }, 19_000)
    expect(text).toContain('**Matchup:** The Googies 116.1 vs Team 5 94.6 projected\nBy slot (yours vs theirs): QB 18.3–20.0\n')
    expect(text).toContain('- **WR** Parker Washington · Jax · proj n/a · locked')
    expect(text).toContain('- **DEF** — empty: no eligible player can play')
    expect(text).toContain('Bench: Jordan Addison, Jayden Daniels (O), J.K. Dobbins, Nico Collins (O), Bhayshul Tuten, Isaiah Likely, Steelers')
    expect(text).toContain('## Moves\nWaiver period 2 days\nNo suggested add raises the projected lineup over weeks 3, 4, 5.\n')
    expect(text).toContain('## Since the Thursday update\n- No Yahoo status, roster, or move changes.')
    expect(text).not.toContain('## Bye outlook')
    expect(text).toContain('1. Bench Steelers — before the first Sunday kickoff (Sun, Sep 27, 10:00 AM MST)')
    expect(text).not.toContain('## Close calls')
    expect(text).not.toContain('## Sources')
    const { matchup: _matchup, chip: _chip, since: _since, deadlines: _deadlines, ...rest } = view
    const unmatched = { ...rest, byes: [] }
    const bare = renderReport({ ...unmatched, moves: { ...quiet, enabled: false }, comparisons: [], game: () => undefined,
      players: new Map([['P1', synthetic('Locked Bench', ['QB'], { slotLocked: true, selectedSlot: 'BN', status: 'O' })]]),
      lineup: [{ slot: 'QB', player: undefined }],
      calls: new Map([['P1', { call: 'HOLD' as const, reason: 'Benched.', sources: [], origin: 'default' as const }]]) }, 19_000)
    expect(bare).not.toContain('**Matchup:**')
    expect(bare).not.toContain('## Moves')
    expect(bare).not.toContain('## Trade chip')
    expect(bare).not.toContain('## Since')
    expect(bare).toContain('## Checklist\n1. Set the final lineup before each starter\'s kickoff\n')
    expect(bare).toContain('Bench: Locked Bench (O) (locked)')
    expect(bare).toContain('**Locked Bench — HOLD** · QB · code reason\nBenched.')
    const full = renderReport({ ...unmatched, moves: { ...quiet, enabled: false, irMoves: [] }, comparisons: [], game: () => undefined,
      players: new Map([['P1', synthetic('New Starter', ['QB'], { status: 'Q' })]]), lineup: [{ slot: 'QB', player: 'P1' }],
      calls: new Map([['P1', { call: 'START' as const, reason: 'Starts.', sources: [], origin: 'model' as const }]]) }, 19_000)
    expect(full).toContain('- **QB** New Starter · proj n/a · Yahoo Q · **start** (Yahoo BN)')
    expect(full).toContain('1. Start New Starter — before his game starts\n2. Recheck New Starter (Q) on the Wednesday and Friday practice reports'
      + ' — before his game starts\n')
    const sunday = renderReport({ ...unmatched, mode: 'sunday', moves: { ...quiet, enabled: false }, comparisons: [], game: () => undefined,
      players: new Map([['P1', synthetic('New Starter', ['QB'], { status: 'Q', selectedSlot: 'QB' })]]), lineup: [{ slot: 'QB', player: 'P1' }],
      calls: new Map([['P1', { call: 'START' as const, reason: 'Starts.', sources: [], origin: 'model' as const }]]) }, 19_000)
    expect(sunday).toContain('1. Recheck New Starter (Q) on the final injury report and inactives')
    expect(full).not.toContain('Bench:')
  })
})
