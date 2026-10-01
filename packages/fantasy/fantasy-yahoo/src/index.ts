/** Read-only Yahoo Fantasy v2 provider and human OAuth command. @module @deepseek-ai/dsh-fantasy-yahoo */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FantasyService, TeamKey } from '@deepseek-ai/dsh-fantasy'
import type { Session } from '@deepseek-ai/dsh-session'
import type { FantasyPlayer, LeagueKey as LeagueId, PlayerKey as PlayerId, TeamKey as TeamId } from '@deepseek-ai/dsh-fantasy/types'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { YahooTokenStore } from './token.ts'
import { parseDraft, parseGameWeeks, parseLeagueSettings, parseLeagues, parseMatchups, parsePlayers,
  parseRoster, parseStandings, parseTransactions } from './parse.ts'

export { YahooTokenStore, parseTokenRecord, validateTokenPaths, withTokenLock, writeTokenAtomic } from './token.ts'
export * from './parse.ts'

/** Provider deployment values. Token and OAuth secrets remain inside the private store. */
export interface Config {
  /** Absolute private JSON store path below DSH_HOME. */
  readonly tokenFile: string
  /** Optional private yahoo_oauth cache copied once when the DSH store is absent. */
  readonly importFrom?: string
  /** Exact HTTPS OAuth callback URI configured in the Yahoo app. */
  readonly redirectUri: string
  /** NFL season used to list the account's leagues. */
  readonly season: number
  /** Trusted Agent preset IDs mapped to Yahoo team keys. */
  readonly callerTeams: Readonly<Record<string, string>>
  /** Agent presets allowed to use the human authorization command. */
  readonly authPresets: string[]
  /** Milliseconds to retain a parsed API response. */
  readonly cacheTtlMs?: number
  /** Maximum cached response entries. */
  readonly cacheMaxEntries?: number
  /** Additional attempts for rate-limit and temporary server errors. */
  readonly retryCount?: number
  /** Initial retry delay in milliseconds. */
  readonly retryDelayMs?: number
  /** Deadline in milliseconds for each Yahoo HTTP request. */
  readonly requestTimeoutMs?: number
  /** Maximum milliseconds to wait for the store lock. */
  readonly lockWaitMs?: number
  /** Milliseconds before stale lock recovery begins. */
  readonly lockStaleMs?: number
}

/** Loader validation; direct construction is validated again below. */
export const Config: z<Config> = z.object({
  tokenFile: z.string().required(),
  importFrom: z.string(),
  redirectUri: z.string().required(),
  season: z.number().step(1).min(2000).max(2100).required(),
  callerTeams: z.dict(z.string()).required(),
  authPresets: z.array(z.string()).required(),
  cacheTtlMs: z.number().step(1).min(0).max(3_600_000).default(60_000),
  cacheMaxEntries: z.number().step(1).min(1).max(500).default(50),
  retryCount: z.number().step(1).min(0).max(5).default(2),
  retryDelayMs: z.number().step(1).min(1).max(60_000).default(1_000),
  requestTimeoutMs: z.number().step(1).min(1).max(120_000).default(15_000),
  lockWaitMs: z.number().step(1).min(1).max(300_000).default(30_000),
  lockStaleMs: z.number().step(1).min(1_000).max(3_600_000).default(120_000),
})

type ResolvedConfig = Required<Omit<Config, 'importFrom'>> & Pick<Config, 'importFrom'>

function resolveConfig(config: Config): ResolvedConfig {
  const resolved = {
    tokenFile: config.tokenFile,
    ...(config.importFrom === undefined ? {} : { importFrom: config.importFrom }),
    redirectUri: config.redirectUri,
    season: config.season,
    callerTeams: config.callerTeams,
    authPresets: config.authPresets,
    cacheTtlMs: config.cacheTtlMs ?? 60_000,
    cacheMaxEntries: config.cacheMaxEntries ?? 50,
    retryCount: config.retryCount ?? 2,
    retryDelayMs: config.retryDelayMs ?? 1_000,
    requestTimeoutMs: config.requestTimeoutMs ?? 15_000,
    lockWaitMs: config.lockWaitMs ?? 30_000,
    lockStaleMs: config.lockStaleMs ?? 120_000,
  }
  for (const [field, min, max] of [
    ['season', 2000, 2100], ['cacheTtlMs', 0, 3_600_000], ['cacheMaxEntries', 1, 500],
    ['retryCount', 0, 5], ['retryDelayMs', 1, 60_000], ['requestTimeoutMs', 1, 120_000],
    ['lockWaitMs', 1, 300_000], ['lockStaleMs', 1_000, 3_600_000],
  ] as const) {
    const value = resolved[field]
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`fantasy-yahoo: ${field} must be an integer from ${min} through ${max}`)
    }
  }
  const redirect = new URL(resolved.redirectUri)
  if (redirect.protocol !== 'https:' || redirect.username !== '' || redirect.password !== '' || redirect.hash !== '') {
    throw new Error('fantasy-yahoo: redirectUri must be an HTTPS URL without credentials or fragment')
  }
  if (Object.keys(resolved.callerTeams).length === 0) throw new Error('fantasy-yahoo: callerTeams must name a preset')
  for (const [preset, key] of Object.entries(resolved.callerTeams)) {
    if (!/^[a-z][a-z0-9-]*$/u.test(preset)) throw new Error('fantasy-yahoo: callerTeams has an invalid preset id')
    TeamKey(key)
  }
  if (resolved.authPresets.length === 0 || resolved.authPresets.some(preset => resolved.callerTeams[preset] === undefined)) {
    throw new Error('fantasy-yahoo: authPresets must name configured caller presets')
  }
  return resolved
}

function pathPart(value: string): string { return encodeURIComponent(value) }

/** Yahoo provider; only GET requests reach the Fantasy REST API. */
export class YahooFantasyService extends FantasyService {
  static inject = ['commands']
  static Config = Config
  private readonly config: ResolvedConfig
  private readonly tokens: YahooTokenStore
  private readonly cache = new Map<string, { at: number; value: unknown }>()
  private readonly states = new Map<string, string>()
  private readonly fetcher: typeof fetch

  constructor(ctx: Context, config: Config, fetcher: typeof fetch = fetch) {
    super(ctx)
    this.config = resolveConfig(config)
    this.tokens = new YahooTokenStore(this.config, fetcher)
    this.fetcher = fetcher
    ctx.effect(() => ctx.commands.register({
      name: 'fantasy',
      description: 'Authorize Yahoo Fantasy or inspect the read-only connection.',
      input: { hint: 'auth [callback URL or code] | status' },
      recordInput: false,
      handler: invocation => this.command(invocation.rawInput, String(invocation.agent.session.id),
        invocation.agent.session.header.agentPreset, invocation.signal),
    }), 'fantasy human command')
  }

  /** Resolve "my team" only from the trusted Session preset recorded at creation. */
  teamFor(caller: Session): TeamId {
    const preset = caller.header.agentPreset
    const key = preset === undefined ? undefined : this.config.callerTeams[preset]
    if (key === undefined) throw new Error('fantasy: no team is configured for this caller')
    return TeamKey(key)
  }

  private async get(path: string, signal?: AbortSignal, bypassCache = false): Promise<unknown> {
    const cached = this.cache.get(path)
    if (!bypassCache && cached !== undefined && Date.now() - cached.at < this.config.cacheTtlMs) return cached.value
    const url = new URL(`https://fantasysports.yahooapis.com/fantasy/v2${path}`)
    url.searchParams.set('format', 'json')
    let token = await this.tokens.accessToken()
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted()
      let response: Response
      try {
        response = await this.fetcher(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
          signal: signal === undefined ? AbortSignal.timeout(this.config.requestTimeoutMs)
            : AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)]),
        })
      } catch { throw new Error('fantasy-yahoo: API unavailable') }
      if (response.status === 401 && attempt === 0) {
        token = await this.tokens.accessToken(token)
        continue
      }
      if ((response.status === 429 || response.status === 503) && attempt <= this.config.retryCount) {
        const retryAfter = Number(response.headers.get('retry-after'))
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1_000, 60_000) : this.config.retryDelayMs * 2 ** attempt
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delay)
          signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('fantasy-yahoo: request cancelled')) }, { once: true })
        })
        continue
      }
      if (!response.ok) throw new Error(`fantasy-yahoo: API request failed (HTTP ${response.status})`)
      let value: unknown
      try { value = await response.json() } catch { throw new Error('fantasy-yahoo: invalid API response') }
      this.cache.set(path, { at: Date.now(), value })
      while (this.cache.size > this.config.cacheMaxEntries) {
        const first = this.cache.keys().next().value as string
        this.cache.delete(first)
      }
      return value
    }
  }

  async leagues(signal?: AbortSignal) {
    return parseLeagues(await this.get(`/users;use_login=1/games;game_codes=nfl;seasons=${this.config.season}/leagues`, signal))
  }
  async league(key: LeagueId, signal?: AbortSignal) {
    return parseLeagueSettings(await this.get(`/league/${pathPart(key)}/settings`, signal))
  }
  async standings(key: LeagueId, signal?: AbortSignal) {
    return parseStandings(await this.get(`/league/${pathPart(key)}/standings`, signal))
  }
  async scoreboard(key: LeagueId, week?: number, signal?: AbortSignal) {
    return parseMatchups(await this.get(`/league/${pathPart(key)}/scoreboard${week === undefined ? '' : `;week=${week}`}`, signal))
  }
  async matchups(key: TeamId, week?: number, signal?: AbortSignal) {
    // Yahoo ignores `;week=` on team matchups and returns the whole season; `;weeks=` selects one.
    const matchups = parseMatchups(await this.get(`/team/${pathPart(key)}/matchups${week === undefined ? '' : `;weeks=${week}`}`, signal))
    return week === undefined ? matchups : matchups.filter(matchup => matchup.week === week)
  }
  async team(key: TeamId, week: number, signal?: AbortSignal) {
    return parseRoster(await this.get(`/team/${pathPart(key)}/roster;week=${week}/players/stats;type=week;week=${week}`, signal))
  }
  async players(league: LeagueId, query: {
    search?: string
    status?: 'FA' | 'W'
    position?: string
    sort?: 'points' | 'rank' | 'percent_owned'
    start: number
    count: number
    week?: number
  }, signal?: AbortSignal): Promise<readonly FantasyPlayer[]> {
    const serverSort = query.sort === 'percent_owned' ? undefined : query.sort
    const filters = [
      ...(query.search === undefined ? [] : [`search=${encodeURIComponent(query.search)}`]),
      ...(query.status === undefined ? [] : [`status=${query.status}`]),
      ...(query.position === undefined ? [] : [`position=${encodeURIComponent(query.position)}`]),
      ...(serverSort === undefined ? [] : [`sort=${{ points: 'PTS', rank: 'AR' }[serverSort]}`]),
      ...(serverSort === undefined || query.week === undefined ? []
        : ['sort_type=week', `sort_week=${query.week}`]),
      `start=${query.start}`, `count=${query.count}`,
    ]
    const suffix = `/stats${query.week === undefined ? '' : `;type=week;week=${query.week}`}`
    const raw = await this.get(`/league/${pathPart(league)}/players;${filters.join(';')};out=percent_owned,ownership${suffix}`, signal)
    const players = parsePlayers(raw)
    return query.sort === 'percent_owned'
      ? players.sort((a, b) => (b.percentOwned ?? -1) - (a.percentOwned ?? -1) || a.name.localeCompare(b.name))
      : players
  }
  async player(league: LeagueId, key: PlayerId, week?: number, signal?: AbortSignal): Promise<FantasyPlayer> {
    const suffix = week === undefined ? '/stats' : `/stats;type=week;week=${week}`
    const players = parsePlayers(await this.get(
      `/league/${pathPart(league)}/players;player_keys=${pathPart(key)};out=percent_owned,ownership${suffix}`, signal))
    const found = players.find(player => player.key === key)
    if (found === undefined) throw new Error('fantasy-yahoo: player unavailable')
    return found
  }
  async transactions(key: LeagueId, start: number, count: number, signal?: AbortSignal) {
    return parseTransactions(await this.get(`/league/${pathPart(key)}/transactions;start=${start};count=${count}`, signal))
  }
  async draft(key: LeagueId, signal?: AbortSignal) {
    return parseDraft(await this.get(`/league/${pathPart(key)}/draftresults`, signal))
  }
  async gameWeeks(signal?: AbortSignal) {
    return parseGameWeeks(await this.get('/game/nfl/game_weeks', signal))
  }

  /** Build a human-facing authorization URL; it contains no client secret or token.
   * @param caller - Session identity that owns the OAuth state.
   * @returns URL for the configured Yahoo app and read-only scope.
   */
  async authorizationUrl(caller: string): Promise<string> {
    const state = randomUUID()
    this.states.set(caller, state)
    const url = new URL('https://api.login.yahoo.com/oauth2/request_auth')
    url.searchParams.set('client_id', await this.tokens.clientId())
    url.searchParams.set('redirect_uri', this.config.redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', 'fspt-r')
    url.searchParams.set('state', state)
    return url.toString()
  }

  /** Validate a callback URL or a pasted code and replace the private token store.
   * @param caller - Session identity that owns the OAuth state.
   * @param input - full callback URL or authorization code.
   */
  async authorize(caller: string, input: string): Promise<void> {
    const value = input.trim()
    let code: string
    if (value.startsWith('https://')) {
      const callback = new URL(value)
      const expected = new URL(this.config.redirectUri)
      if (callback.origin !== expected.origin || callback.pathname !== expected.pathname) {
        throw new Error('fantasy: callback URL does not match the configured redirect')
      }
      const state = this.states.get(caller)
      if (state === undefined || callback.searchParams.get('state') !== state) {
        throw new Error('fantasy: callback state does not match this authorization')
      }
      code = callback.searchParams.get('code') ?? ''
    } else {
      code = value
    }
    if (!/^[A-Za-z0-9._~-]{1,2048}$/u.test(code)) throw new Error('fantasy: invalid authorization code')
    await this.tokens.authorize(code, this.config.redirectUri)
    this.states.delete(caller)
    this.cache.clear()
  }

  /** Handle the human-only command without recording callback input or token responses.
   * @param input - command input omitted from Session events.
   * @param caller - human caller Session identity.
   * @param preset - trusted preset allowed to authorize.
   * @param signal - caller cancellation.
   * @returns human-readable safe status or authorization result.
   */
  async command(input: string, caller: string, preset?: string, signal?: AbortSignal): Promise<CommandResult> {
    const trimmed = input.trim()
    if (trimmed.startsWith('auth') && (preset === undefined || !this.config.authPresets.includes(preset))) {
      return { kind: 'error', text: 'Yahoo Fantasy authorization is unavailable in this lane.' }
    }
    if (trimmed === 'auth') return { kind: 'success', text: await this.authorizationUrl(caller) }
    if (trimmed.startsWith('auth ')) {
      try {
        await this.authorize(caller, trimmed.slice(5))
        return { kind: 'success', text: 'Yahoo Fantasy authorization saved.' }
      } catch { return { kind: 'error', text: 'Yahoo Fantasy authorization failed. Check the callback and try /fantasy auth again.' } }
    }
    if (trimmed === 'status') {
      const token = await this.tokens.status()
      let api = 'unreachable'
      let leagueCount = 0
      try {
        const leagues = parseLeagues(await this.get(
          `/users;use_login=1/games;game_codes=nfl;seasons=${this.config.season}/leagues`, signal, true))
        api = 'reachable'
        leagueCount = leagues.length
      } catch { /* Status reports reachability without returning a token or server body. */ }
      return { kind: 'success', text: JSON.stringify({
        token_age_seconds: token.tokenAgeSeconds, last_refresh: token.lastRefresh,
        api, league_count: leagueCount, caller_teams: this.config.callerTeams,
      }) }
    }
    return { kind: 'error', text: 'Usage: /fantasy auth [callback URL or code] | status' }
  }
}

export default YahooFantasyService
