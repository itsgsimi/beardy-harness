import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FantasyNflService, PlayerKey } from '@deepseek-ai/dsh-fantasy'
import type { FantasyPlayer } from '@deepseek-ai/dsh-fantasy/types'
import { type Config, NflverseService } from '../src/index.ts'

const fixture = (name: string): string => readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8')
const files: Readonly<Record<string, string>> = {
  'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv': fixture('games.csv'),
  'https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_2026.csv':
    fixture('stats_player_week_2026.csv'),
  'https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_2026.csv': fixture('snap_counts_2026.csv'),
}

const player = (id: number, name: string, nflTeam: string | undefined, positions: string[]): FantasyPlayer =>
  ({ key: PlayerKey(`470.p.${id}`), name, nflTeam, positions })
const nacua = player(1, 'Puka Nacua', 'LAR', ['WR', 'W/R/T'])
const williams = player(2, 'Kyren Williams', 'Lar', ['RB', 'W/R/T'])
const harrison = player(3, 'Marvin Harrison', 'Hou', ['WR', 'W/R/T', 'IR'])
const jefferson = player(4, 'Justin Jefferson', 'Min', ['WR'])
const rams = player(5, 'Los Angeles Rams', 'LAR', ['DEF'])
const kicker = player(6, 'Puka Nacua', 'LAR', ['K'])
const nobody = player(7, 'Nobody Here', 'LAR', ['WR'])

const contexts: Context[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function provider(fetcher: typeof fetch, config: Config = {}): NflverseService {
  const ctx = new Context()
  contexts.push(ctx)
  return new NflverseService(ctx, config, fetcher)
}

function serving(overrides: Readonly<Record<string, string | number>> = {}): { fetcher: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    expect(init).toMatchObject({ method: 'GET', redirect: 'follow' })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
    calls.push(url)
    const body = overrides[url] ?? files[url]
    if (typeof body === 'number') return new Response('secret body', { status: body })
    return body === undefined ? new Response('missing', { status: 404 }) : new Response(body)
  })
  return { fetcher, calls }
}

describe('NflverseService games', () => {
  it('returns one regular-season week with UTC kickoffs, Yahoo team codes, and absent blank fields', async () => {
    const { fetcher, calls } = serving()
    const service = provider(fetcher)
    expect(service).toBeInstanceOf(FantasyNflService)
    expect(await service.games(2026, 7)).toEqual([
      { week: 7, kickoff: '2026-10-23T00:15:00.000Z', home: 'CHI', away: 'NE', homeSpread: 2.5, total: 49.5, roof: 'outdoors' },
      { week: 7, kickoff: '2026-10-25T13:30:00.000Z', home: 'NO', away: 'PIT', homeSpread: -2.5, total: 43.5, roof: 'dome' },
      { week: 7, kickoff: '2026-10-25T17:00:00.000Z', home: 'ATL', away: 'SF', homeSpread: -4.5, total: 50.5 },
      { week: 7, kickoff: '2026-10-25T17:00:00.000Z', home: 'HOU', away: 'NYG', homeSpread: 9.5, total: 43.5 },
      { week: 7, kickoff: '2026-10-25T20:25:00.000Z', home: 'LV', away: 'LAR', homeSpread: -5.5, total: 46.5, roof: 'dome' },
    ])
    expect(await service.games(2026, 9)).toEqual([
      { week: 9, kickoff: '2026-11-06T01:15:00.000Z', home: 'BAL', away: 'JAX', roof: 'outdoors' },
    ])
    expect(await service.games(2025, 7)).toHaveLength(1)
    expect(await service.games(2025, 22)).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('skips rows without a parsable kickoff, season, week, or teams', async () => {
    const header = 'season,game_type,week,gameday,gametime,away_team,home_team,spread_line,total_line,roof'
    const body = [header, '2026,REG,1,2026-09-10,,DAL,PHI,,,', '2026,REG,1,,20:20,DAL,PHI,,,', '2026,REG,1,09/10/2026,20:20,DAL,PHI,,,',
      ',REG,1,2026-09-10,20:20,DAL,PHI,,,', '2026,REG,x,2026-09-10,20:20,DAL,PHI,,,', '2026,REG,1,2026-09-10,20:20,,PHI,,,',
      '2026,REG,1,2026-09-10,20:20,DAL,,,,', '2026,REG,1,2026-09-10,20:20,DAL,PHI,n/a,47', '2026,REG,1,2026-09-10,20:20,DAL,PHI'].join('\n')
    const { fetcher } = serving({ 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv': body })
    expect(await provider(fetcher).games(2026, 1)).toEqual([
      { week: 1, kickoff: '2026-09-11T00:20:00.000Z', home: 'PHI', away: 'DAL', total: 47 },
      { week: 1, kickoff: '2026-09-11T00:20:00.000Z', home: 'PHI', away: 'DAL' },
    ])
  })
})

describe('NflverseService usage', () => {
  it('matches players by name, team, and position, with traded players by name and position', async () => {
    const { fetcher, calls } = serving()
    const usage = await provider(fetcher).usage(2026, [6, 4, 5, 4], [nacua, williams, harrison, jefferson, rams, kicker, nobody])
    expect(calls).toHaveLength(2)
    expect([...usage.keys()]).toEqual([nacua.key, williams.key, harrison.key, jefferson.key])
    expect(usage.get(nacua.key)).toEqual([
      { week: 4, team: 'LAR', opponent: 'PHI', targets: 12, targetShare: 0.24, receptions: 9, carries: 1, snapShare: 0.9 },
      { week: 5, team: 'LAR', opponent: 'BUF', targets: 24, targetShare: 0.444444444444444, receptions: 17, carries: 2,
        snapShare: 0.85 },
      { week: 6, team: 'LAR', opponent: 'ARI', targets: 7, targetShare: 0.21875, receptions: 6, carries: 0 },
    ])
    expect(usage.get(williams.key)?.map(row => row.week)).toEqual([4, 5, 6])
    expect(usage.get(harrison.key)).toEqual([
      { week: 4, team: 'ARI', opponent: 'NYG', targets: 4, targetShare: 0.114285714285714, receptions: 1, carries: 0, snapShare: 0.65 },
      { week: 6, team: 'HOU', opponent: 'JAX', targets: 4, targetShare: 0.125, receptions: 3, carries: 0 },
    ])
    expect(usage.get(jefferson.key)).toEqual([
      { week: 5, team: 'MIN', opponent: 'NO', targets: 7, targetShare: 0.241379310344828, receptions: 6, carries: 1, snapShare: 0.89 },
    ])
  })

  it('leaves namesakes ambiguous without a team match and uses snap rows when stats are missing', async () => {
    const stats = 'player_display_name,position,team,opponent_team,week,season_type,targets,target_share,receptions,carries\n'
      + 'Sam Twin,WR,NYJ,MIA,1,REG,3,,,\nSam Twin,WR,NYG,DAL,1,REG,5,,,\nLate Back,RB,KC,DEN,1,POST,1,,,\nBlank,,KC,DEN,1,REG,,,,\n'
    const snaps = 'player,position,team,opponent,week,game_type,offense_pct\nLate Back,RB,KC,,1,REG,0.5\nLate Back,RB,KC,DEN,2,WC,1\n'
    const { fetcher } = serving({
      'https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_2026.csv': stats,
      'https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_2026.csv': snaps,
    })
    const twin = player(10, 'Sam Twin', 'BUF', ['WR'])
    const twinJets = player(11, 'Sam Twin', 'NYJ', ['WR'])
    const back = player(12, 'Late Back', undefined, ['RB'])
    const usage = await provider(fetcher).usage(2026, [1, 2], [twin, twinJets, back])
    expect(usage.has(twin.key)).toBe(false)
    expect(usage.get(twinJets.key)).toEqual([{ week: 1, team: 'NYJ', opponent: 'MIA', targets: 3 }])
    expect(usage.get(back.key)).toEqual([{ week: 1, team: 'KC', snapShare: 0.5 }])
  })

  it('substitutes the season into both templates', async () => {
    const { fetcher, calls } = serving({
      'https://data.example/stats/2025.csv': fixture('stats_player_week_2026.csv'),
      'https://data.example/snaps.csv?season=2025': fixture('snap_counts_2026.csv'),
    })
    const service = provider(fetcher, { statsUrlTemplate: 'https://data.example/stats/{season}.csv',
      snapsUrlTemplate: 'https://data.example/snaps.csv?season={season}' })
    expect((await service.usage(2025, [5], [jefferson])).size).toBe(1)
    expect(calls).toEqual(['https://data.example/stats/2025.csv', 'https://data.example/snaps.csv?season=2025'])
  })
})

describe('NflverseService requests', () => {
  it('shares one request per URL among concurrent callers and reuses it until the TTL passes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { fetcher, calls } = serving()
    const service = provider(fetcher, { cacheTtlMs: 1_000 })
    await Promise.all([service.games(2026, 7), service.games(2026, 9), service.usage(2026, [4], [nacua])])
    expect(calls).toHaveLength(3)
    vi.advanceTimersByTime(999)
    await service.games(2026, 7)
    expect(calls).toHaveLength(3)
    vi.advanceTimersByTime(1)
    await service.games(2026, 7)
    expect(calls).toHaveLength(4)
  })

  it('forgets a failed request so the next caller retries', async () => {
    let fail = true
    const { fetcher: files } = serving()
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (fail) throw new Error('offline')
      return await files(input, init)
    })
    const service = provider(fetcher)
    await expect(service.games(2026, 7)).rejects.toThrow('fantasy-nflverse: schedule unavailable')
    fail = false
    expect(await service.games(2026, 7)).toHaveLength(5)
  })

  it('keeps a newer request cached when an expired one fails later', async () => {
    const pending: Array<(response: Response) => void> = []
    const rejects: Array<(error: Error) => void> = []
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>((resolve, reject) => {
      pending.push(resolve)
      rejects.push(reject)
    }))
    const service = provider(fetcher, { cacheTtlMs: 0 })
    const first = service.games(2026, 7)
    const second = service.games(2026, 7)
    await vi.waitFor(() => { expect(pending).toHaveLength(2) })
    rejects[0]!(new Error('offline'))
    await expect(first).rejects.toThrow('fantasy-nflverse: schedule unavailable')
    pending[1]!(new Response(fixture('games.csv')))
    expect(await second).toHaveLength(5)
  })

  it('reports HTTP failures without the body and names the failing file', async () => {
    const { fetcher } = serving({
      'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv': 503,
      'https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_2026.csv': 404,
    })
    const service = provider(fetcher)
    const schedule = service.games(2026, 7)
    await expect(schedule).rejects.toThrow(/^fantasy-nflverse: schedule request failed \(HTTP 503\)$/u)
    await expect(service.usage(2026, [4], [nacua])).rejects.toThrow('fantasy-nflverse: snaps request failed (HTTP 404)')
  })

  it('rejects a file without a required column', async () => {
    const { fetcher } = serving({
      'https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_2026.csv': 'player_name,week\nX,1\n',
    })
    await expect(provider(fetcher).usage(2026, [1], [nacua])).rejects.toThrow('fantasy-nflverse: stats CSV lacks column player_display_name')
  })

  it('rejects a redirect that leaves HTTPS and accepts one that stays on HTTPS', async () => {
    const redirected = (url: string): typeof fetch => async () => {
      const response = new Response(fixture('games.csv'))
      Object.defineProperty(response, 'url', { value: url })
      return response
    }
    await expect(provider(redirected('http://objects.example/games.csv')).games(2026, 7))
      .rejects.toThrow('fantasy-nflverse: schedule redirected away from HTTPS')
    expect(await provider(redirected('https://objects.example/games.csv')).games(2026, 7)).toHaveLength(5)
  })

  it('bounds the body size, cancels the stream, and reads an empty body as no rows', async () => {
    const cancel = vi.fn()
    // A plain response object keeps the source stream unwrapped, so the provider's cancellation reaches it.
    const streaming = (chunks: string[], cancelThrows = false): typeof fetch => async () => ({ ok: true, status: 200, url: '',
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks.shift()
          if (chunk === undefined) controller.close()
          else controller.enqueue(new TextEncoder().encode(chunk))
        },
        cancel() {
          cancel()
          if (cancelThrows) throw new Error('cannot cancel')
        },
      }) }) as Response
    const header = 'season,game_type,week,gameday,gametime,away_team,home_team,spread_line,total_line,roof\n'
    await expect(provider(streaming([header, 'x'.repeat(200), 'unread']), { maxResponseBytes: 150 }).games(2026, 1))
      .rejects.toThrow('fantasy-nflverse: schedule response exceeds 150 bytes')
    await expect(provider(streaming([header, 'x'.repeat(200), 'unread'], true), { maxResponseBytes: 150 }).games(2026, 1))
      .rejects.toThrow('fantasy-nflverse: schedule response exceeds 150 bytes')
    expect(cancel).toHaveBeenCalledTimes(2)
    expect(await provider(streaming([header.slice(0, 50), header.slice(50)]), { maxResponseBytes: header.length }).games(2026, 1))
      .toEqual([])
    await expect(provider(async () => new Response(null)).games(2026, 1)).rejects.toThrow('fantasy-nflverse: schedule CSV lacks column season')
  })

  it('reports a body that fails while streaming as unavailable', async () => {
    const fetcher: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(new Error('reset')) },
    }))
    await expect(provider(fetcher).games(2026, 7)).rejects.toThrow('fantasy-nflverse: schedule unavailable')
  })

  it('lets one caller abort without cancelling the shared request', async () => {
    let release: ((response: Response) => void) | undefined
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { release = resolve }))
    const service = provider(fetcher)
    const aborted = new AbortController()
    const waiting = service.games(2026, 7, aborted.signal)
    const other = service.games(2026, 7, new AbortController().signal)
    aborted.abort(new Error('caller left'))
    await expect(waiting).rejects.toThrow('caller left')
    await vi.waitFor(() => { expect(release).toBeDefined() })
    release!(new Response(fixture('games.csv')))
    expect(await other).toHaveLength(5)
    await expect(service.usage(2026, [4], [nacua], aborted.signal)).rejects.toThrow('caller left')
  })

  it('uses the global fetch by default', async () => {
    const { fetcher } = serving()
    vi.stubGlobal('fetch', fetcher)
    try {
      const ctx = new Context()
      contexts.push(ctx)
      expect(await new NflverseService(ctx).games(2026, 7)).toHaveLength(5)
      expect(fetcher).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('NflverseService configuration', () => {
  it('validates configuration at construction', () => {
    const { fetcher } = serving()
    expect(() => provider(fetcher, { cacheTtlMs: 86_400_001 })).toThrow('cacheTtlMs must be an integer from 0 through 86400000')
    expect(() => provider(fetcher, { requestTimeoutMs: 0 })).toThrow('requestTimeoutMs must be an integer from 1 through 300000')
    expect(() => provider(fetcher, { maxResponseBytes: 1.5 })).toThrow('maxResponseBytes must be an integer from 1 through 104857600')
    for (const scheduleUrl of ['http://data.example/games.csv', 'https://u:p@data.example/games.csv', 'https://:p@data.example/x', 'not a url']) {
      expect(() => provider(fetcher, { scheduleUrl })).toThrow('fantasy-nflverse: scheduleUrl must be an HTTPS URL without credentials')
    }
    expect(() => provider(fetcher, { statsUrlTemplate: 'https://data.example/stats.csv' }))
      .toThrow('fantasy-nflverse: statsUrlTemplate must contain {season}')
    expect(() => provider(fetcher, { snapsUrlTemplate: 'http://data.example/{season}.csv' }))
      .toThrow('fantasy-nflverse: snapsUrlTemplate must be an HTTPS URL without credentials')
    expect(NflverseService.Config({})).toEqual({
      scheduleUrl: 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv',
      statsUrlTemplate: 'https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_{season}.csv',
      snapsUrlTemplate: 'https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_{season}.csv',
      cacheTtlMs: 21_600_000, requestTimeoutMs: 60_000, maxResponseBytes: 20_971_520,
    })
    expect(() => NflverseService.Config({ cacheTtlMs: -1 })).toThrow()
  })
})
