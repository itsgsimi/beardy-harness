import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseDraft, parseGameWeeks, parseLeagueSettings, parseLeagues, parseMatchups,
  parsePlayers, parseRoster, parseStandings, parseTransactions } from '../src/parse.ts'

const fixtureRoot = fileURLToPath(new URL('./fixtures/', import.meta.url))
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(`${fixtureRoot}${name}.json`, 'utf8'))
}

describe('Yahoo numbered collections and partial objects', () => {
  it('reads both authenticated user leagues instead of reporting zero', () => {
    const leagues = parseLeagues(fixture('user-leagues'))
    expect(leagues.map(league => league.key)).toEqual(['470.l.809970', '470.l.1520327'])
    expect(leagues[0]).toMatchObject({ name: 'League 1', season: '2026', currentWeek: 3, teamCount: 10 })
  })

  it('reads settings, starting slots, stat categories, and score multipliers', () => {
    const settings = parseLeagueSettings(fixture('league-settings'))
    expect(settings.league.key).toBe('470.l.809970')
    expect(settings.rosterSlots.length).toBeGreaterThan(5)
    expect(settings.rosterSlots.some(slot => slot.position === 'QB' && slot.starting)).toBe(true)
    expect(settings.scoring.length).toBeGreaterThan(10)
    expect(settings.scoring.some(stat => stat.value !== undefined)).toBe(true)
  })

  it('reads standings and the five projected week-three matchups', () => {
    const standings = parseStandings(fixture('league-standings'))
    expect(standings).toHaveLength(10)
    expect(standings[0]).toMatchObject({ rank: 1, wins: 2 })
    const scoreboard = parseMatchups(fixture('league-scoreboard'))
    expect(scoreboard).toHaveLength(5)
    expect(scoreboard.every(matchup => matchup.week === 3 && matchup.teams.length === 2)).toBe(true)
    expect(scoreboard[0]?.teams[0]).toMatchObject({ points: 0, projectedPoints: 109.67 })
    const teamMatchups = parseMatchups(fixture('team-matchups'))
    expect(teamMatchups).toHaveLength(1)
    expect(teamMatchups[0]?.teams).toHaveLength(2)
  })

  it('reads roster slots, injury, bye, week scores, and per-stat numbers', () => {
    const roster = parseRoster(fixture('team-roster-week-stats'))
    expect(roster.team.key).toBe('470.l.809970.t.7')
    expect(roster.week).toBe(3)
    expect(roster.players).toHaveLength(15)
    expect(roster.players[0]).toMatchObject({ selectedSlot: 'QB', byeWeek: 7, points: 0 })
    expect(Object.keys(roster.players[0]?.stats ?? {}).length).toBeGreaterThan(10)
    expect(roster.players.some(player => player.injuryNote !== undefined)).toBe(true)
    expect(roster.players.every(player => player.slotLocked === false)).toBe(true)
    expect(parsePlayers(fixture('league-fa-rb')).every(player => !('slotLocked' in player))).toBe(true)
  })

  it('reads a started game as a locked slot and leaves an unrecognized editability flag unknown', () => {
    const raw = fixture('team-roster-week-stats') as { fantasy_content: { team: [unknown, { roster: Record<string, unknown> }] } }
    const players = (raw.fantasy_content.team[1].roster['0'] as { players: Record<string, { player: unknown[] }> }).players
    const editability = (index: number): { is_editable: unknown } => players[String(index)]!.player[2] as { is_editable: unknown }
    editability(0).is_editable = 0
    editability(1).is_editable = '0'
    editability(2).is_editable = 'unknown'
    const roster = parseRoster(raw)
    expect(roster.players.slice(0, 4).map(player => player.slotLocked)).toEqual([true, true, undefined, false])
    expect(roster.players[2]).not.toHaveProperty('slotLocked')
  })

  it('reads free agents, waivers, and searched player statistics', () => {
    const agents = parsePlayers(fixture('league-fa-rb'))
    expect(agents).toHaveLength(10)
    expect(agents[0]).toMatchObject({ percentOwned: 58 })
    expect(parsePlayers(fixture('league-waivers-all'))).toHaveLength(10)
    const searched = parsePlayers(fixture('player-search'))
    expect(searched).toHaveLength(1)
    expect(searched[0]?.stats).toBeDefined()
    expect(searched[0]?.points).toBeTypeOf('number')
  })

  it('reads transactions, draft picks, and the game calendar', () => {
    const transactions = parseTransactions(fixture('league-transactions'))
    expect(transactions).toHaveLength(10)
    expect(transactions[0]?.players.map(entry => entry.movement)).toEqual(['add', 'drop'])
    expect(transactions[0]?.players[0]?.teamKey).toBe('470.l.809970.t.5')
    const draft = parseDraft(fixture('league-draftresults'))
    expect(draft).toHaveLength(150)
    expect(draft[0]).toMatchObject({ pick: 1, round: 1 })
    const weeks = parseGameWeeks(fixture('game-weeks'))
    expect(weeks).toHaveLength(18)
    expect(weeks[2]?.currentDate).toBe('2026-09-27')
  })

  it('rejects a missing root and malformed identity', () => {
    expect(() => parseLeagues({})).toThrow('fantasy_content')
    expect(() => parseLeagues({ fantasy_content: { league: [{ league_key: 'bad', name: 'x' }] } })).toThrow('league key')
    expect(() => parseRoster({ fantasy_content: { team: [[{ team_key: '470.l.1.t.1' }, { name: 'x' }],
      { roster: {} }] } })).toThrow('roster has no week')
  })
})
