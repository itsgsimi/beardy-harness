/** nflverse schedule, betting line, and usage provider. @module @deepseek-ai/dsh-fantasy-nflverse */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FantasyNflService } from '@deepseek-ai/dsh-fantasy'
import type { FantasyNflGame, FantasyNflUsage, FantasyPlayer, PlayerKey } from '@deepseek-ai/dsh-fantasy/types'
import { type CsvRow, parseTable, scheduleGames, type SeasonGame, type TableKind, UsageIndex } from './csv.ts'

export { type CsvRow, easternKickoff, parseTable, scheduleGames, type SeasonGame, type TableKind, UsageIndex, type WeekRow, yahooTeam } from './csv.ts'

/** Provider deployment values. */
export interface Config {
  /** HTTPS URL of the all-seasons schedule CSV. */
  readonly scheduleUrl?: string
  /** HTTPS URL of one season's weekly player stats CSV; `{season}` is replaced by the season year. */
  readonly statsUrlTemplate?: string
  /** HTTPS URL of one season's snap counts CSV; `{season}` is replaced by the season year. */
  readonly snapsUrlTemplate?: string
  /** Milliseconds one file is reused after its request starts; `0` requests every time. */
  readonly cacheTtlMs?: number
  /** Deadline in milliseconds for each request, including reading its body. */
  readonly requestTimeoutMs?: number
  /** Largest response body in bytes; a larger body fails its request. */
  readonly maxResponseBytes?: number
}

const DEFAULTS = {
  scheduleUrl: 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv',
  statsUrlTemplate: 'https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_{season}.csv',
  snapsUrlTemplate: 'https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_{season}.csv',
  cacheTtlMs: 21_600_000,
  requestTimeoutMs: 60_000,
  maxResponseBytes: 20_971_520,
} as const

const LIMITS = [
  ['cacheTtlMs', 0, 86_400_000], ['requestTimeoutMs', 1, 300_000], ['maxResponseBytes', 1, 104_857_600],
] as const

/** Loader validation; direct construction is validated again below. */
export const Config: z<Config> = z.object({
  scheduleUrl: z.string().default(DEFAULTS.scheduleUrl),
  statsUrlTemplate: z.string().default(DEFAULTS.statsUrlTemplate),
  snapsUrlTemplate: z.string().default(DEFAULTS.snapsUrlTemplate),
  cacheTtlMs: z.number().step(1).min(0).max(86_400_000).default(DEFAULTS.cacheTtlMs),
  requestTimeoutMs: z.number().step(1).min(1).max(300_000).default(DEFAULTS.requestTimeoutMs),
  maxResponseBytes: z.number().step(1).min(1).max(104_857_600).default(DEFAULTS.maxResponseBytes),
})

type ResolvedConfig = Required<Config>

function checkUrl(field: string, value: string): void {
  let url: URL
  try { url = new URL(value) } catch { throw new Error(`fantasy-nflverse: ${field} must be an HTTPS URL without credentials`) }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new Error(`fantasy-nflverse: ${field} must be an HTTPS URL without credentials`)
  }
}

function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    scheduleUrl: config.scheduleUrl ?? DEFAULTS.scheduleUrl,
    statsUrlTemplate: config.statsUrlTemplate ?? DEFAULTS.statsUrlTemplate,
    snapsUrlTemplate: config.snapsUrlTemplate ?? DEFAULTS.snapsUrlTemplate,
    cacheTtlMs: config.cacheTtlMs ?? DEFAULTS.cacheTtlMs,
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
    maxResponseBytes: config.maxResponseBytes ?? DEFAULTS.maxResponseBytes,
  }
  for (const [field, min, max] of LIMITS) {
    const value = resolved[field]
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`fantasy-nflverse: ${field} must be an integer from ${min} through ${max}`)
    }
  }
  checkUrl('scheduleUrl', resolved.scheduleUrl)
  for (const field of ['statsUrlTemplate', 'snapsUrlTemplate'] as const) {
    if (!resolved[field].includes('{season}')) throw new Error(`fantasy-nflverse: ${field} must contain {season}`)
    checkUrl(field, resolved[field].replaceAll('{season}', '2026'))
  }
  return resolved
}

/** Await shared work for one caller; that caller's abort rejects its wait while the work continues for others. */
async function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return await work
  signal.throwIfAborted()
  const aborted = Promise.withResolvers<never>()
  const onAbort = (): void => { aborted.reject(signal.reason as Error) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([work, aborted.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

interface CacheEntry<T> {
  readonly at: number
  readonly value: Promise<T>
}

/** nflverse provider; only GET requests reach the configured public files. */
export class NflverseService extends FantasyNflService {
  static Config = Config
  private readonly config: ResolvedConfig
  private readonly fetcher: typeof fetch
  private readonly schedules = new Map<string, CacheEntry<SeasonGame[]>>()
  private readonly stats = new Map<string, CacheEntry<UsageIndex>>()
  private readonly snaps = new Map<string, CacheEntry<UsageIndex>>()

  constructor(ctx: Context, config: Config = {}, fetcher: typeof fetch = fetch) {
    super(ctx)
    this.config = resolveConfig(config)
    this.fetcher = fetcher
  }

  async games(season: number, week: number, signal?: AbortSignal): Promise<readonly FantasyNflGame[]> {
    const games = await untilAborted(this.cached(this.schedules, 'schedule', this.config.scheduleUrl, scheduleGames), signal)
    return games.filter(entry => entry.season === season && entry.game.week === week).map(entry => entry.game)
  }

  async usage(season: number, weeks: readonly number[], players: readonly FantasyPlayer[],
    signal?: AbortSignal): Promise<ReadonlyMap<PlayerKey, readonly FantasyNflUsage[]>> {
    const url = (template: string): string => template.replaceAll('{season}', String(season))
    const [stats, snaps] = await untilAborted(Promise.all([
      this.cached(this.stats, 'stats', url(this.config.statsUrlTemplate), rows => new UsageIndex('stats', rows)),
      this.cached(this.snaps, 'snaps', url(this.config.snapsUrlTemplate), rows => new UsageIndex('snaps', rows)),
    ]), signal)
    const ordered = [...new Set(weeks)].sort((a, b) => a - b)
    const usage = new Map<PlayerKey, FantasyNflUsage[]>()
    for (const player of players) {
      if (player.positions.some(position => position === 'DEF' || position === 'K')) continue
      const rows = ordered.flatMap((week): FantasyNflUsage[] => {
        const stat = stats.match(player, week)
        const snap = snaps.match(player, week)
        const base = stat ?? snap
        if (base === undefined) return []
        return [{ week, team: base.team, ...base.opponent === undefined ? {} : { opponent: base.opponent },
          ...stat?.values, ...snap?.values }]
      })
      if (rows.length > 0) usage.set(player.key, rows)
    }
    return usage
  }

  /** One file's parsed value: a fresh cached request, or a new request that later callers share until it expires or fails. */
  private cached<T>(cache: Map<string, CacheEntry<T>>, kind: TableKind, url: string,
    build: (rows: readonly CsvRow[]) => T): Promise<T> {
    const now = Date.now()
    for (const [key, entry] of cache) if (now - entry.at >= this.config.cacheTtlMs) cache.delete(key)
    const cached = cache.get(url)
    if (cached !== undefined) return cached.value
    const entry = { at: now, value: this.load(kind, url).then(body => build(parseTable(kind, body))) }
    cache.set(url, entry)
    entry.value.catch(() => { if (cache.get(url) === entry) cache.delete(url) })
    return entry.value
  }

  private async load(kind: TableKind, url: string): Promise<string> {
    const signal = AbortSignal.timeout(this.config.requestTimeoutMs)
    let response: Response
    try {
      response = await this.fetcher(url, { method: 'GET', redirect: 'follow', signal })
    } catch { throw new Error(`fantasy-nflverse: ${kind} unavailable`) }
    if (!response.ok) throw new Error(`fantasy-nflverse: ${kind} request failed (HTTP ${response.status})`)
    if (response.url !== '' && new URL(response.url).protocol !== 'https:') {
      throw new Error(`fantasy-nflverse: ${kind} redirected away from HTTPS`)
    }
    return await this.read(kind, response)
  }

  /** Read a body up to `maxResponseBytes`, cancelling the stream once it is exceeded. */
  private async read(kind: TableKind, response: Response): Promise<string> {
    if (response.body === null) return ''
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let size = 0
    let text = ''
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try { chunk = await reader.read() } catch { throw new Error(`fantasy-nflverse: ${kind} unavailable`) }
      if (chunk.done) return text + decoder.decode()
      size += chunk.value.byteLength
      if (size > this.config.maxResponseBytes) {
        try { await reader.cancel() } catch {
          // A source that fails cancellation leaves nothing to release; the size error below is the outcome.
        }
        throw new Error(`fantasy-nflverse: ${kind} response exceeds ${this.config.maxResponseBytes} bytes`)
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
  }
}

export default NflverseService
