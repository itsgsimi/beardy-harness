import { expect, it } from 'vitest'
import { parseDraft, parseGameWeeks, parseLeagueSettings, parseLeagues, parseMatchups,
  parsePlayers, parseRoster, parseTransactions } from '../src/parse.ts'

const wrapped = (body: object) => ({ fantasy_content: body })
const league = [{ league_key: '470.l.809970', name: 'Fixture League' }]
const player = [{ player_key: '470.p.1', name: { full: 'Player One' }, display_position: 'RB,WR' }]

it('accepts sparse and numbered league settings while rejecting missing identities', () => {
  expect(parseLeagues(wrapped({ league: [league] }))).toEqual([{ key: '470.l.809970', name: 'Fixture League' }])
  expect(() => parseLeagues(wrapped({ league: [[{ league_key: '470.l.809970', name: '' }]] })))
    .toThrow('league name')
  expect(() => parseLeagueSettings(wrapped({ settings: {} }))).toThrow('no league')
  const settings = {
    roster_positions: {
      count: 2,
      1: { roster_position: { position: 'BN', count: '2', is_starting_position: '0' } },
      0: { roster_position: { position: 'RB', is_starting_position: '1' } },
      2: { ignored: true },
    },
    stat_modifiers: { stats: { 0: { stat: { stat_id: '5', value: '0.5' } },
      1: { stat: { value: 2 } }, 2: { stat: { stat_id: '8' } } } },
    stat_categories: { stats: { 0: { stat: { stat_id: '5', name: 'Yards' } },
      1: { stat: { stat_id: 8, display_name: 'Score', abbr: 'SC' } }, 2: { ignored: true } } },
    draft_type: 'live', waiver_type: 'FAB', waiver_rule: 'game', trade_end_date: '2026-11-01',
    playoff_start_week: '15',
  }
  const value = parseLeagueSettings(wrapped({ league: [league, { settings }] }))
  expect(value.rosterSlots).toEqual([
    { position: 'RB', count: 0, starting: true },
    { position: 'BN', count: 2, starting: false },
  ])
  expect(value.scoring).toEqual([
    { id: '5', name: 'Yards', value: 0.5 },
    { id: '8', name: 'Score', abbreviation: 'SC' },
  ])
  expect(value).toMatchObject({ draftType: 'live', waiverType: 'FAB', waiverRule: 'game',
    tradeEndDate: '2026-11-01', playoffStartWeek: 15 })
  expect(parseLeagueSettings(wrapped({ league: [league], settings: {} })))
    .toMatchObject({ league: { key: '470.l.809970' }, rosterSlots: [], scoring: [] })
})

it('parses partial matchups and players and rejects absent weeks', () => {
  expect(() => parseMatchups(wrapped({ matchup: [{ team: [[{ team_key: '470.l.809970.t.1',
    name: 'One' }]] }] }))).toThrow('no week')
  const matchups = parseMatchups(wrapped({ matchup: [{ week: '3', status: 'live',
    teams: { 0: { team: [[{ team_key: '470.l.809970.t.1', name: 'One' }]] },
      1: { team: [[{ team_key: '470.l.809970.t.2', name: 'Two' }]] } } }] }))
  expect(matchups[0]).toMatchObject({ week: 3, status: 'live' })
  expect(parseMatchups(wrapped({ matchup: [{ week: 4 }] }))).toEqual([{ week: 4, teams: [] }])
  const minimal = parsePlayers(wrapped({ players: { 0: { player }, 1: { player: [{}] } } }))
  expect(minimal[0]).toMatchObject({ key: '470.p.1', positions: ['RB', 'WR'] })
  expect(parsePlayers(wrapped({ player: [[{ player_key: '470.p.3', name: { full: 'Player Three' } }]] }))[0]?.positions)
    .toEqual([])
  const rich = parsePlayers(wrapped({ player: [[
    { player_key: '470.p.2', name: { full: 'Player Two' }, editorial_team_abbr: 'ARI',
      eligible_positions: [{ position: 'QB' }, { ignored: true }], selected_position: [{ position: 'QB' }],
      status: 'Q', injury_note: 'ankle', bye_weeks: { week: '8' }, rank: '4',
      ownership: { ownership_type: 'freeagents' } },
    { player_points: { total: '11.5' }, player_projected_points: { total: '14.5' },
      percent_owned: [{ value: '42' }], player_stats: { stats: { 0: { stat: { stat_id: '5', value: '20' } },
        1: { stat: { stat_id: '6' } }, 2: { stat: { value: '7' } } } } },
  ]] }))
  expect(rich[0]).toMatchObject({ positions: ['QB'], selectedSlot: 'QB', status: 'Q', injuryNote: 'ankle',
    byeWeek: 8, points: 11.5, projectedPoints: 14.5, percentOwned: 42, rank: 4,
    ownershipType: 'freeagents', stats: { 5: 20 } })
  expect(() => parseRoster(wrapped({ roster: { week: '3' } }))).toThrow('no team')
})

it('supports sparse transactions and catches malformed draft and game weeks', () => {
  const transactions = parseTransactions(wrapped({ transaction: [
    [{ transaction_key: 'tr.1', type: 'add' }, { players: { 0: { player: [
      ...player, { transaction_data: [{ source_team_key: '470.l.809970.t.1' }] },
    ] } } }],
  ] }))
  expect(transactions[0]).toMatchObject({ key: 'tr.1', type: 'add',
    players: [{ teamKey: '470.l.809970.t.1' }] })
  const noTeam = parseTransactions(wrapped({ transaction: [[{ transaction_key: 'tr.2', type: 'drop' },
    { player }]] }))
  expect(noTeam[0]?.players[0]?.teamKey).toBeUndefined()
  expect(() => parseDraft(wrapped({ draft_result: [{ pick: 1 }] }))).toThrow('lacks pick or round')
  expect(() => parseGameWeeks(wrapped({ game_week: [{ start: '2026-09-01' }] }))).toThrow('no week')
  expect(parseGameWeeks(wrapped({ game_week: [{ week: 1, start: '2026-09-01', end: '2026-09-07' }] })))
    .toEqual([{ week: 1, start: '2026-09-01', end: '2026-09-07' }])
})
