/** Week 3 NFL schedule with betting lines and recent usage rows, in place of a live NFL data provider. Baltimore hosts
 * Detroit on Thursday night, so two starters have an early kickoff. */
import { FantasyNflService } from '@deepseek-ai/dsh-fantasy'

/** Games: [away, home, kickoff in UTC, home spread, total]. */
const GAMES = [
  ['DET', 'BAL', '2026-09-25T00:15:00Z', 2.5, 51.5],
  ['JAX', 'HOU', '2026-09-27T17:00:00Z', 1.5, 44.5],
  ['MIN', 'ATL', '2026-09-27T17:00:00Z', -1, 46],
  ['IND', 'TEN', '2026-09-27T17:00:00Z', 3, 41],
  ['NYG', 'WAS', '2026-09-27T17:00:00Z', 4.5, 43.5],
  ['CHI', 'PIT', '2026-09-27T17:00:00Z', 2.5, 40.5],
  ['DEN', 'NYJ', '2026-09-27T17:00:00Z', -2, 39],
  ['LAC', 'SEA', '2026-09-27T20:05:00Z', -1.5, 45],
]

/** Usage rows by player name: [week, team, opponent, targets, target share, receptions, carries, snap share]. */
const USAGE = {
  'Olamide Zaccheaus': [[1, 'ATL', 'TB', 6, 0.22, 4, 0, 0.71], [2, 'ATL', 'CAR', 8, 0.27, 6, 0, 0.84]],
  'Parker Washington': [[1, 'JAX', 'MIA', 9, 0.3, 7, 0, 0.9], [2, 'JAX', 'CIN', 8, 0.27, 6, 1, 0.88]],
}

export default class FantasyReportNflFixture extends FantasyNflService {
  async games(season, week) {
    if (season !== 2026 || week !== 3) return []
    return GAMES.map(([away, home, kickoff, homeSpread, total]) => ({ week, kickoff, home, away, homeSpread, total, roof: 'outdoors' }))
  }

  async usage(season, weeks, players) {
    return new Map(players.flatMap(player => USAGE[player.name] === undefined ? [] : [[player.key, USAGE[player.name]
      .filter(([week]) => season === 2026 && weeks.includes(week))
      .map(([week, team, opponent, targets, targetShare, receptions, carries, snapShare]) =>
        ({ week, team, opponent, targets, targetShare, receptions, carries, snapShare }))]]))
  }
}
