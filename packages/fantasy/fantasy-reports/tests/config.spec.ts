import { describe, expect, it } from 'vitest'
import { cronerScheduler } from '@deepseek-ai/dsh-cron'
import { Config as Schema, DEFAULT_EXCLUDED_HOSTS, resolveConfig, type Config } from '../src/config.ts'
import { deliveryChannel, formatReportTag, localDate, parseReportTag, reportSchedules } from '../src/index.ts'

/** The two teams and Wednesday/Thursday/Sunday starts the Odysseus service used, in its timezone. */
const household = {
  timezone: 'America/Phoenix',
  workspacePath: '/home/goran/.dsh/fantasy-reports',
  teams: [
    { id: 'googies', name: 'The Googies', teamKey: '470.l.809970.t.7', channelId: '1472404859679670455',
      schedule: { full: '0 14 * * 3', thursday: '0 11 * * 4', sunday: '30 5 * * 0' } },
    { id: 'lights', name: 'Lights Kamara Action', teamKey: '470.l.809970.t.6', channelId: '1549767364634087444',
      schedule: { full: '30 15 * * 3', thursday: '30 12 * * 4', sunday: '0 7 * * 0' } },
  ],
} satisfies Config

/** Weekday and local time of an expression's next fire, independent of today's date. */
function nextLocal(expression: string): string {
  const job = cronerScheduler({ expression, timezone: 'America/Phoenix' }, () => {})
  const next = job.nextRunAt() as number
  job.stop()
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Phoenix', weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(next)
}

describe('report configuration', () => {
  it('maps each team to its own channel and three staggered Phoenix starts', () => {
    const config = resolveConfig(household)
    const rows = reportSchedules(config)
    expect(rows.map(row => [row.team.id, row.mode, row.expression, row.timezone])).toEqual([
      ['googies', 'full', '0 14 * * 3', 'America/Phoenix'], ['googies', 'thursday', '0 11 * * 4', 'America/Phoenix'],
      ['googies', 'sunday', '30 5 * * 0', 'America/Phoenix'], ['lights', 'full', '30 15 * * 3', 'America/Phoenix'],
      ['lights', 'thursday', '30 12 * * 4', 'America/Phoenix'], ['lights', 'sunday', '0 7 * * 0', 'America/Phoenix'],
    ])
    expect(rows.map(row => nextLocal(row.expression))).toEqual([
      'Wed 2:00 PM', 'Thu 11:00 AM', 'Sun 5:30 AM', 'Wed 3:30 PM', 'Thu 12:30 PM', 'Sun 7:00 AM'])
    const [googies, lights] = config.teams
    expect(googies).toMatchObject({ leagueKey: '470.l.809970', teamKey: '470.l.809970.t.7' })
    expect(deliveryChannel(config, googies!)).toBe('1472404859679670455')
    expect(deliveryChannel(config, lights!)).toBe('1549767364634087444')
  })

  it('routes every team to the shadow channel while shadow mode is on', () => {
    const config = resolveConfig({ ...household, shadowChannelId: '1472404859679670455' })
    expect(config.teams.map(team => deliveryChannel(config, team))).toEqual(['1472404859679670455', '1472404859679670455'])
  })

  it('applies defaults and accepts overrides inside their bounds', () => {
    const config = resolveConfig(household)
    expect(config).toMatchObject({ firstWeek: 1, lastWeek: 17, minimumStartGapMs: 5_400_000, searchesPerPlayer: 2,
      pagesPerPlayer: 2, maxReviews: 3, maxStructuralRepairs: 2, runTimeoutMs: 14_400_000, maxDeliveryChars: 19_000 })
    expect(config.excludedHosts).toEqual(DEFAULT_EXCLUDED_HOSTS)
    expect(config).not.toHaveProperty('shadowChannelId')
    expect(resolveConfig({ ...household, excludedHosts: [' Example.COM '], firstWeek: 2, lastWeek: 2 }))
      .toMatchObject({ excludedHosts: ['example.com'], firstWeek: 2, lastWeek: 2 })
    expect(Schema({ ...household })).toMatchObject({ maxPlayers: 30, excludedHosts: [...DEFAULT_EXCLUDED_HOSTS] })
  })

  it('rejects unusable routes, identities, schedules, and bounds at load', () => {
    const team = household.teams[0]!
    const cases: Array<[Partial<Config>, RegExp]> = [
      [{ maxReviews: 0 }, /maxReviews must be an integer from 1 through 6/],
      [{ runTimeoutMs: 1.5 }, /runTimeoutMs/],
      [{ firstWeek: 5, lastWeek: 4 }, /lastWeek must not precede firstWeek/],
      [{ workspacePath: 'relative' }, /workspacePath must be absolute/],
      [{ timezone: 'Mars/Olympus' }, /not an IANA timezone/],
      [{ shadowChannelId: 'goran' }, /shadowChannelId/],
      [{ excludedHosts: ['not a host'] }, /excludedHosts/],
      [{ teams: [] }, /at least one team/],
      [{ teams: [{ ...team, id: 'Googies' }] }, /team id/],
      [{ teams: [team, { ...team, teamKey: '470.l.809970.t.6' }] }, /duplicate team id googies/],
      [{ teams: [{ ...team, name: ' ' }] }, /needs a name/],
      [{ teams: [{ ...team, channelId: '12' }] }, /channelId/],
      [{ teams: [{ ...team, teamKey: '470.l.809970' }] }, /invalid fantasy team key/],
      [{ teams: [team, { ...team, id: 'copy' }] }, /duplicate team key/],
      [{ teams: [{ ...team, schedule: { ...team.schedule, sunday: '99 * * * *' } }] }, /./],
    ]
    for (const [override, error] of cases) expect(() => resolveConfig(Object.assign({}, household, override))).toThrow(error)
  })

  it('tags, parses, and dates reports in the configured timezone', () => {
    const tag = formatReportTag({ team: 'lights', season: '2026', week: 3, mode: 'thursday' })
    expect(tag).toBe('[fantasy-report:lights:2026:3:thursday]')
    expect(parseReportTag(`Lights weekly fantasy report ${tag}`)).toEqual({ team: 'lights', season: '2026', week: 3, mode: 'thursday' })
    expect(parseReportTag('General research question')).toBeUndefined()
    expect(localDate(Date.UTC(2026, 8, 24, 5, 0), 'America/Phoenix')).toBe('2026-09-23')
  })
})
