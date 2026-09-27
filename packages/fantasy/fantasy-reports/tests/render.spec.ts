import { describe, expect, it } from 'vitest'
import type { Evidence, FantasyDraft } from '../src/draft.ts'
import { formatInstant, renderReport, type RenderInput } from '../src/render.ts'
import { WEDNESDAY_WEEK_3, playerPage, rosterIds, validDraft, yahoo } from './support.ts'

const players = new Map(yahoo.roster.players.map((player, index) => [rosterIds[index]!, player]))
const evidence: Evidence[] = rosterIds.slice(1).map((id, index) => ({ id: index + 2, url: playerPage(index + 1).url,
  title: index === 0 ? 'Gibbs [news] <update>' : `Player ${index + 2}`, players: [id], text: playerPage(index + 1).text }))
const input: RenderInput = { teamName: 'The Googies', season: '2026', week: 3, mode: 'thursday', firedAt: WEDNESDAY_WEEK_3,
  timezone: 'America/Phoenix', players, slots: yahoo.settings.rosterSlots, matchups: yahoo.matchups, evidence }

function draft(): FantasyDraft {
  const base = validDraft()
  return { ...base, players: base.players.map(row => row.player === 'P1' ? { ...row, facts: [] }
    : row.player === 'P5' ? { ...row, recommendation: 'CONDITIONAL' } : row) }
}

describe('report rendering', () => {
  it('leads with actions and the lineup, then close calls, every player with Yahoo facts, next checks, and cited sources', () => {
    const text = renderReport(draft(), { ...input, note: 'Reviewer notes applied without another review.' }, 19_000)
    expect(formatInstant(WEDNESDAY_WEEK_3, 'America/Phoenix')).toBe('Wed, Sep 23, 2:00 PM MST')
    expect(text.startsWith('# The Googies · 2026 week 3 Thursday update\n**Wed, Sep 23, 2:00 PM MST · Yahoo roster, slots, and scoring**')).toBe(true)
    expect(text).toContain('Yahoo matchup: Team 6 (projected 116.1) vs Team 5 (projected 94.6)')
    expect(text.indexOf('## What to do now')).toBeLessThan(text.indexOf('## Suggested lineup'))
    expect(text).toContain('- **WR** — Zay Flowers — conditional')
    expect(text).toContain('**Zay Flowers — Conditional start** · WR · Bal · Yahoo slot WR · bye 13 · status Q (Hamstring)')
    expect(text).toContain('**Jayden Daniels — Bench** · QB · Was · Yahoo slot BN · bye 7 · status O (Elbow)')
    expect(text).toContain('Breece Hall keeps the flex over the bench options this week. [7](<https://news.example/p7>)')
    expect(text).toContain('- No current source was admitted for Trevor Lawrence; their rows rest on Yahoo data only.')
    expect(text).toContain('- Reviewer notes applied without another review.')
    expect(text).toContain('[2 · Gibbs news update](<https://news.example/p2>)')
    expect(text).not.toContain('Changes from your Yahoo lineup')
    expect(text).not.toMatch(/\]\(https?:/u)
  })

  it('lists lineup changes and projections, and drops bench rationale when the full report is too long', () => {
    const current = draft()
    const moved: FantasyDraft = { ...current,
      lineup: current.lineup.map(item => item.slot === 'W/R/T' ? { ...item, player: 'P8' } : item),
      players: current.players.map(row => row.player === 'P8' ? { ...row, recommendation: 'START' }
        : row.player === 'P7' ? { ...row, recommendation: 'SIT', reason: 'x'.repeat(500) } : row) }
    const projected = new Map(players)
    projected.set('P8', { ...players.get('P8')!, projectedPoints: 11.25 })
    const full = renderReport(moved, { ...input, players: projected }, 19_000)
    expect(full).toContain('## Changes from your Yahoo lineup\n- Start Jordan Addison\n- Bench Breece Hall')
    expect(full).toContain('· projected 11.3')
    expect(full).toContain('x'.repeat(500))
    const compact = renderReport(moved, { ...input, players: projected }, full.length - 1)
    expect(compact).not.toContain('x'.repeat(500))
    expect(compact).toContain('**Breece Hall — Bench**')
    expect(compact).toContain('Row P8: the practice report supports this choice.')
    const unprojected = [{ week: 3, teams: [{ ...yahoo.matchups[0]!.teams[0]!, projectedPoints: undefined }] }]
    const noMatchup = renderReport(moved, { ...input, matchups: unprojected }, 19_000)
    expect(noMatchup).toContain('Yahoo matchup: Team 6 (projected n/a)')
  })

  it('omits Yahoo fields a player does not have', () => {
    const sparse = new Map(players)
    const { nflTeam: _team, byeWeek: _bye, status: _status, injuryNote: _note, selectedSlot: _slot, ...kicker } = players.get('P14')!
    sparse.set('P14', kicker)
    sparse.set('P5', { ...players.get('P5')!, injuryNote: undefined })
    const text = renderReport(draft(), { ...input, players: sparse }, 19_000)
    expect(text).toContain('**Cairo Santos — Start** · K · Yahoo slot n/a\n')
    expect(text).toContain('## Changes from your Yahoo lineup\n- Start Cairo Santos\n')
    expect(text).toContain('· bye 13 · status Q\n')
  })

  it('renders uncited or unknown source numbers without links', () => {
    const current = draft()
    const text = renderReport({ ...current, decisions: [{ title: 'Missing', text: 'A comparison that cites a missing source.', sources: [99] }] },
      { ...input, evidence: evidence.slice(0, 1) }, 19_000)
    expect(text).toContain('**Missing**\nA comparison that cites a missing source.\n')
    expect(text).not.toContain('[99')
  })
})
