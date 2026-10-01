import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FantasyProjectionService, PlayerKey } from '@deepseek-ai/dsh-fantasy'
import type { FantasyPlayer } from '@deepseek-ai/dsh-fantasy/types'
import { SleeperProjectionService, type Config } from '../src/index.ts'

const body = readFileSync(new URL('fixtures/projections-week5.json', import.meta.url), 'utf8')

const allen: FantasyPlayer = { key: PlayerKey('470.p.30977'), name: 'Josh Allen', nflTeam: 'Buf', positions: ['QB'] }
const texans: FantasyPlayer = { key: PlayerKey('470.p.100034'), name: 'Texans', nflTeam: 'Hou', positions: ['DEF'] }
const unknown: FantasyPlayer = { key: PlayerKey('470.p.1'), name: 'Nobody Here', nflTeam: 'Buf', positions: ['WR'] }

const contexts: Context[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function provider(fetcher: typeof fetch, config: Config = {}): SleeperProjectionService {
  const ctx = new Context()
  contexts.push(ctx)
  return new SleeperProjectionService(ctx, config, fetcher)
}

function serving(text = body, status = 200): { fetcher: typeof fetch; calls: URL[] } {
  const calls: URL[] = []
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    expect(init?.method).toBe('GET')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    calls.push(new URL(input instanceof Request ? input.url : input))
    return new Response(text, { status })
  })
  return { fetcher, calls }
}

describe('SleeperProjectionService', () => {
  it('requests one week, translates matched rows, and leaves unmatched players out', async () => {
    const { fetcher, calls } = serving()
    const service = provider(fetcher)
    expect(service).toBeInstanceOf(FantasyProjectionService)
    const lines = await service.project(2026, 5, [allen, texans, unknown])
    expect(calls.map(String)).toEqual(['https://api.sleeper.com/projections/nfl/2026/5?season_type=regular'
      + '&position%5B%5D=QB&position%5B%5D=RB&position%5B%5D=WR&position%5B%5D=TE&position%5B%5D=K&position%5B%5D=DEF'])
    expect([...lines.keys()]).toEqual([allen.key, texans.key])
    expect(lines.get(allen.key)).toMatchObject({ 4: 251.24, 5: 1.55, 6: 0.9, 9: 39.07, 10: 1.04 })
    expect(lines.get(texans.key)).toMatchObject({ 32: 2.68, 54: 1 })
  })

  it('applies configured origin, season type, and positions, and drops rows of other positions', async () => {
    const { fetcher, calls } = serving()
    const service = provider(fetcher, { baseUrl: 'https://sleeper.example/api/', seasonType: 'post', positions: ['QB'] })
    const lines = await service.project(2026, 1, [allen, texans])
    expect(String(calls[0])).toBe('https://sleeper.example/api/projections/nfl/2026/1?season_type=post&position%5B%5D=QB')
    expect([...lines.keys()]).toEqual([allen.key])
  })

  it('omits matched players whose rows project no mapped stat', async () => {
    const { fetcher } = serving(JSON.stringify([{ team: 'BUF', player: { first_name: 'Josh', last_name: 'Allen', position: 'QB' },
      stats: { adp_dd_ppr: 1000 } }]))
    expect((await provider(fetcher).project(2026, 5, [allen])).size).toBe(0)
  })

  it('shares one request per week among concurrent callers and reuses it until the TTL passes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { fetcher, calls } = serving()
    const service = provider(fetcher, { cacheTtlMs: 1_000 })
    await Promise.all([service.project(2026, 5, [allen]), service.project(2026, 5, [texans])])
    await service.project(2026, 6, [allen])
    expect(calls).toHaveLength(2)
    vi.advanceTimersByTime(999)
    await service.project(2026, 5, [allen])
    expect(calls).toHaveLength(2)
    vi.advanceTimersByTime(1)
    await service.project(2026, 5, [allen])
    expect(calls).toHaveLength(3)
  })

  it('forgets a failed request so the next caller retries', async () => {
    let fail = true
    const fetcher = vi.fn<typeof fetch>(async () => {
      if (fail) throw new Error('offline')
      return new Response(body)
    })
    const service = provider(fetcher)
    await expect(service.project(2026, 5, [allen])).rejects.toThrow('fantasy-projections-sleeper: API unavailable')
    fail = false
    expect((await service.project(2026, 5, [allen])).size).toBe(1)
  })

  it('keeps a newer request cached when an expired one fails later', async () => {
    const pending: Array<(response: Response) => void> = []
    const rejects: Array<(error: Error) => void> = []
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>((resolve, reject) => {
      pending.push(resolve)
      rejects.push(reject)
    }))
    const service = provider(fetcher, { cacheTtlMs: 0 })
    const first = service.project(2026, 5, [allen])
    const second = service.project(2026, 5, [allen])
    await vi.waitFor(() => { expect(pending).toHaveLength(2) })
    rejects[0]!(new Error('offline'))
    await expect(first).rejects.toThrow('fantasy-projections-sleeper: API unavailable')
    pending[1]!(new Response(body))
    expect((await second).size).toBe(1)
  })

  it('reports HTTP failures, unparsable bodies, and non-array bodies', async () => {
    await expect(provider(serving('nope', 503).fetcher).project(2026, 5, [allen]))
      .rejects.toThrow('fantasy-projections-sleeper: API request failed (HTTP 503)')
    await expect(provider(serving('{').fetcher).project(2026, 5, [allen]))
      .rejects.toThrow('fantasy-projections-sleeper: invalid API response')
    await expect(provider(serving('{}').fetcher).project(2026, 5, [allen]))
      .rejects.toThrow('fantasy-projections-sleeper: projection response is not an array')
  })

  it('lets one caller abort without cancelling the shared request', async () => {
    let release: ((response: Response) => void) | undefined
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { release = resolve }))
    const service = provider(fetcher)
    const aborted = new AbortController()
    const waiting = service.project(2026, 5, [allen], aborted.signal)
    const other = service.project(2026, 5, [allen], new AbortController().signal)
    aborted.abort(new Error('caller left'))
    await expect(waiting).rejects.toThrow('caller left')
    await vi.waitFor(() => { expect(release).toBeDefined() })
    release!(new Response(body))
    expect((await other).size).toBe(1)
    await expect(service.project(2026, 5, [allen], aborted.signal)).rejects.toThrow('caller left')
  })

  it('validates configuration at construction', () => {
    const { fetcher } = serving()
    expect(() => provider(fetcher, { cacheTtlMs: -1 })).toThrow('cacheTtlMs must be an integer from 0 through 86400000')
    expect(() => provider(fetcher, { requestTimeoutMs: 1.5 })).toThrow('requestTimeoutMs must be an integer from 1 through 120000')
    expect(() => provider(fetcher, { seasonType: 'spring' as 'pre' })).toThrow('seasonType must be regular, pre, or post')
    for (const baseUrl of ['http://api.sleeper.com', 'https://u:p@api.sleeper.com', 'https://api.sleeper.com?x=1', 'https://api.sleeper.com#x']) {
      expect(() => provider(fetcher, { baseUrl })).toThrow('baseUrl must be an HTTPS URL without credentials, query, or fragment')
    }
    expect(() => provider(fetcher, { positions: [] })).toThrow('positions must name one or more uppercase Sleeper positions')
    expect(() => provider(fetcher, { positions: ['qb'] })).toThrow('positions must name one or more uppercase Sleeper positions')
    expect(SleeperProjectionService.Config({})).toEqual({ baseUrl: 'https://api.sleeper.com', seasonType: 'regular',
      positions: ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'], cacheTtlMs: 3_600_000, requestTimeoutMs: 20_000 })
  })

  it('uses the global fetch by default', async () => {
    const fetcher = vi.fn(async () => new Response(body))
    vi.stubGlobal('fetch', fetcher)
    try {
      const ctx = new Context()
      contexts.push(ctx)
      expect((await new SleeperProjectionService(ctx).project(2026, 5, [allen])).size).toBe(1)
      expect(fetcher).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
