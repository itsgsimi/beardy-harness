/** Sleeper weekly stat-line projection provider. @module @deepseek-ai/dsh-fantasy-projections-sleeper */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FantasyProjectionService } from '@deepseek-ai/dsh-fantasy'
import type { FantasyPlayer, PlayerKey } from '@deepseek-ai/dsh-fantasy/types'
import { parseRows, ProjectionIndex, translate } from './sleeper.ts'

export { normalizeName, parseRows, ProjectionIndex, type SleeperRow, translate } from './sleeper.ts'

/** Provider deployment values. */
export interface Config {
  /** HTTPS origin of the Sleeper API. */
  readonly baseUrl?: string
  /** Sleeper season type of the projected week. */
  readonly seasonType?: 'regular' | 'pre' | 'post'
  /** Sleeper positions requested; rows with none of them among their positions never match. */
  readonly positions?: string[]
  /** Milliseconds one week's projections are reused after their request starts; `0` requests every time. */
  readonly cacheTtlMs?: number
  /** Deadline in milliseconds for each Sleeper HTTP request. */
  readonly requestTimeoutMs?: number
}

/** Loader validation; direct construction is validated again below. */
export const Config: z<Config> = z.object({
  baseUrl: z.string().default('https://api.sleeper.com'),
  seasonType: z.union(['regular', 'pre', 'post']).default('regular'),
  positions: z.array(z.string()).default(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']),
  cacheTtlMs: z.number().step(1).min(0).max(86_400_000).default(3_600_000),
  requestTimeoutMs: z.number().step(1).min(1).max(120_000).default(20_000),
})

type ResolvedConfig = Required<Config>

function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    baseUrl: config.baseUrl ?? 'https://api.sleeper.com',
    seasonType: config.seasonType ?? 'regular',
    positions: config.positions ?? ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'],
    cacheTtlMs: config.cacheTtlMs ?? 3_600_000,
    requestTimeoutMs: config.requestTimeoutMs ?? 20_000,
  }
  for (const [field, min, max] of [['cacheTtlMs', 0, 86_400_000], ['requestTimeoutMs', 1, 120_000]] as const) {
    const value = resolved[field]
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`fantasy-projections-sleeper: ${field} must be an integer from ${min} through ${max}`)
    }
  }
  if (!['regular', 'pre', 'post'].includes(resolved.seasonType)) {
    throw new Error('fantasy-projections-sleeper: seasonType must be regular, pre, or post')
  }
  const base = new URL(resolved.baseUrl)
  if (base.protocol !== 'https:' || base.username !== '' || base.password !== '' || base.search !== '' || base.hash !== '') {
    throw new Error('fantasy-projections-sleeper: baseUrl must be an HTTPS URL without credentials, query, or fragment')
  }
  if (resolved.positions.length === 0 || resolved.positions.some(position => !/^[A-Z]{1,4}$/u.test(position))) {
    throw new Error('fantasy-projections-sleeper: positions must name one or more uppercase Sleeper positions')
  }
  return resolved
}

/** Settle with a shared promise, or reject early when this caller's signal aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { reject(signal.reason as Error) }
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
  })
}

/** Sleeper provider; only GET requests reach the public projections endpoint. */
export class SleeperProjectionService extends FantasyProjectionService {
  static Config = Config
  private readonly config: ResolvedConfig
  private readonly cache = new Map<string, { readonly at: number; readonly index: Promise<ProjectionIndex> }>()
  private readonly fetcher: typeof fetch

  constructor(ctx: Context, config: Config = {}, fetcher: typeof fetch = fetch) {
    super(ctx)
    this.config = resolveConfig(config)
    this.fetcher = fetcher
  }

  async project(season: number, week: number, players: readonly FantasyPlayer[],
    signal?: AbortSignal): Promise<ReadonlyMap<PlayerKey, Readonly<Record<string, number>>>> {
    const index = await abortable(this.index(season, week), signal)
    const lines = new Map<PlayerKey, Readonly<Record<string, number>>>()
    for (const player of players) {
      const row = index.match(player)
      const line = row === undefined ? {} : translate(row)
      if (Object.keys(line).length > 0) lines.set(player.key, line)
    }
    return lines
  }

  /** One week's index: a fresh cached request, or a new request that later callers share until it expires or fails. */
  private index(season: number, week: number): Promise<ProjectionIndex> {
    const now = Date.now()
    for (const [key, entry] of this.cache) if (now - entry.at >= this.config.cacheTtlMs) this.cache.delete(key)
    const key = `${season}:${week}`
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached.index
    const entry = { at: now, index: this.load(season, week) }
    this.cache.set(key, entry)
    entry.index.catch(() => { if (this.cache.get(key) === entry) this.cache.delete(key) })
    return entry.index
  }

  private async load(season: number, week: number): Promise<ProjectionIndex> {
    const url = new URL(`projections/nfl/${season}/${week}`, `${this.config.baseUrl.replace(/\/+$/u, '')}/`)
    url.searchParams.set('season_type', this.config.seasonType)
    for (const position of this.config.positions) url.searchParams.append('position[]', position)
    let response: Response
    try {
      response = await this.fetcher(url, { method: 'GET', signal: AbortSignal.timeout(this.config.requestTimeoutMs) })
    } catch { throw new Error('fantasy-projections-sleeper: API unavailable') }
    if (!response.ok) throw new Error(`fantasy-projections-sleeper: API request failed (HTTP ${response.status})`)
    let body: unknown
    try { body = await response.json() } catch { throw new Error('fantasy-projections-sleeper: invalid API response') }
    const positions = new Set(this.config.positions)
    return new ProjectionIndex(parseRows(body).filter(row => row.positions.some(position => positions.has(position))))
  }
}

export default SleeperProjectionService
