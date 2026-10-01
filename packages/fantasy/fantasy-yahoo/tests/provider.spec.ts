import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { LeagueKey, PlayerKey, TeamKey } from '@deepseek-ai/dsh-fantasy'
import YahooFantasyService from '../src/index.ts'
import type { Config as YahooConfig } from '../src/index.ts'

const fixtureRoot = fileURLToPath(new URL('./fixtures/', import.meta.url))
const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup(options: {
  config?: Partial<YahooConfig>
  fetcher?: (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1],
    fallback: typeof fetch) => ReturnType<typeof fetch>
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fantasy-provider-'))
  roots.push(root)
  const home = join(root, 'home')
  await mkdir(home, { mode: 0o700 })
  vi.stubEnv('DSH_HOME', home)
  const tokenFile = join(home, 'fantasy.json')
  const record = { consumer_key: 'public-fixture-client', consumer_secret: 'private-fixture-secret',
    access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'bearer',
    token_time: Date.now() / 1000 }
  await writeFile(tokenFile, JSON.stringify(record), { mode: 0o600 })
  const requested: string[] = []
  const fixtureFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    requested.push(url.pathname)
    if (url.pathname.endsWith('/oauth2/get_token')) {
      expect(init?.method).toBe('POST')
      return new Response(JSON.stringify({ access_token: 'new-private-access',
        refresh_token: 'new-private-refresh', token_type: 'bearer' }), { status: 200 })
    }
    expect(init?.method).toBe('GET')
    expect(url.searchParams.get('format')).toBe('json')
    const file = url.pathname.includes('/users;') ? 'user-leagues'
      : url.pathname.endsWith('/settings') ? 'league-settings'
        : url.pathname.endsWith('/standings') ? 'league-standings'
          : url.pathname.includes('/scoreboard') ? 'league-scoreboard'
            : url.pathname.includes('/matchups') ? 'team-matchups'
              : url.pathname.includes('/roster') ? 'team-roster-week-stats'
                : url.pathname.includes('/transactions') ? 'league-transactions'
                  : url.pathname.includes('/draftresults') ? 'league-draftresults'
                    : url.pathname.includes('/game_weeks') ? 'game-weeks'
                      : url.pathname.includes('/players;search') || url.pathname.includes('/players;player_keys') ? 'player-search'
                        : 'league-fa-rb'
    return new Response(readFileSync(`${fixtureRoot}${file}.json`, 'utf8'), { status: 200 })
  }
  const fetcher: typeof fetch = (input, init) => options.fetcher?.(input, init, fixtureFetch)
    ?? fixtureFetch(input, init)
  vi.stubGlobal('fetch', fetcher)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  const config = { tokenFile, redirectUri: 'https://localhost:8080/oauth', season: 2026,
    callerTeams: { beardy: '470.l.809970.t.7', 'beardy-mamabear': '470.l.809970.t.6' },
    authPresets: ['beardy'], ...options.config }
  const fiber = await ctx.plugin(YahooFantasyService, config)
  const session = ctx.sessions.create(SessionId('fantasy-command'), { meta: { agentPreset: 'beardy' } })
  const agent = { id: session.id, session } as Agent
  return { ctx, fiber, tokenFile, requested, record, agent, config }
}

it('reads all configured Yahoo resources with GET and resolves each preset team', async () => {
  const h = await setup()
  const league = LeagueKey('470.l.809970')
  expect(h.ctx.fantasy.teamFor(h.agent.session)).toBe(TeamKey('470.l.809970.t.7'))
  const mama = h.ctx.sessions.create(SessionId('mama'), { meta: { agentPreset: 'beardy-mamabear' } })
  expect(h.ctx.fantasy.teamFor(mama)).toBe(TeamKey('470.l.809970.t.6'))
  expect(await h.ctx.fantasy.leagues()).toHaveLength(2)
  expect((await h.ctx.fantasy.league(league)).rosterSlots.length).toBeGreaterThan(5)
  expect(await h.ctx.fantasy.standings(league)).toHaveLength(10)
  expect(await h.ctx.fantasy.scoreboard(league, 3)).toHaveLength(5)
  expect(await h.ctx.fantasy.matchups(TeamKey('470.l.809970.t.7'))).toHaveLength(1)
  expect((await h.ctx.fantasy.team(TeamKey('470.l.809970.t.7'), 3)).players).toHaveLength(15)
  expect(h.requested.some(path => path.includes('/roster;week=3/players/stats;type=week;week=3'))).toBe(true)
  expect(await h.ctx.fantasy.players(league, { status: 'FA', position: 'RB', sort: 'rank', start: 0, count: 10 }))
    .toHaveLength(10)
  expect((await h.ctx.fantasy.player(league, (await h.ctx.fantasy.players(league,
    { search: 'kamara', start: 0, count: 10 }))[0]!.key)).key).toMatch(/^470\.p\./u)
  expect(await h.ctx.fantasy.transactions(league, 0, 10)).toHaveLength(10)
  expect(await h.ctx.fantasy.draft(league)).toHaveLength(150)
  expect(await h.ctx.fantasy.gameWeeks()).toHaveLength(18)
  expect(h.requested.every(path => path.includes('/fantasy/v2/'))).toBe(true)
  await h.fiber.dispose()
  expect(h.ctx.get('fantasy')).toBeUndefined()
})

it('keeps callback input and exchanged credentials out of command results and Session events', async () => {
  const h = await setup()
  const signal = new AbortController().signal
  const auth = await h.ctx.commands.execute(h.agent, '/fantasy auth', [], signal)
  expect(auth?.result.kind).toBe('success')
  const url = new URL(auth?.result.text ?? '')
  expect(url.searchParams.get('scope')).toBe('fspt-r')
  expect(url.searchParams.get('redirect_uri')).toBe('https://localhost:8080/oauth')
  expect(url.searchParams.has('client_secret')).toBe(false)
  const callback = `https://localhost:8080/oauth?code=private-fixture-code&state=${url.searchParams.get('state')}`
  const saved = await h.ctx.commands.execute(h.agent, `/fantasy auth ${callback}`, [], signal)
  expect(saved?.result.text).toBe('Yahoo Fantasy authorization saved.')
  const status = await h.ctx.commands.execute(h.agent, '/fantasy status', [], signal)
  expect(status?.result.text).toContain('reachable')
  expect(status?.result.text).toContain('470.l.809970.t.7')
  const logged = JSON.stringify(h.agent.session.snapshotEvents())
  for (const forbidden of ['private-fixture-code', 'private-fixture-secret', 'new-private-access', 'new-private-refresh']) {
    expect(logged).not.toContain(forbidden)
    expect(JSON.stringify(saved)).not.toContain(forbidden)
    expect(JSON.stringify(status)).not.toContain(forbidden)
  }
  expect(JSON.parse(await readFile(h.tokenFile, 'utf8'))).toMatchObject({
    access_token: 'new-private-access', consumer_secret: 'private-fixture-secret',
  })
})

it('rejects a mismatched callback and returns only a safe command error', async () => {
  const h = await setup()
  const signal = new AbortController().signal
  await h.ctx.commands.execute(h.agent, '/fantasy auth', [], signal)
  const result = await h.ctx.commands.execute(h.agent,
    '/fantasy auth https://localhost:8080/other?code=private-fixture-code', [], signal)
  expect(result?.result).toEqual({ kind: 'error',
    text: 'Yahoo Fantasy authorization failed. Check the callback and try /fantasy auth again.' })
  expect(JSON.stringify(h.agent.session.snapshotEvents())).not.toContain('private-fixture-code')
  const mama = h.ctx.sessions.create(SessionId('mama-auth'), { meta: { agentPreset: 'beardy-mamabear' } })
  const denied = await h.ctx.commands.execute({ id: mama.id, session: mama } as Agent,
    '/fantasy auth', [], signal)
  expect(denied?.result.text).toBe('Yahoo Fantasy authorization is unavailable in this lane.')
})

it('validates direct provider configuration and unmapped caller sessions', async () => {
  const h = await setup()
  const make = (overrides: Partial<YahooConfig>) => {
    const ctx = new Context()
    contexts.push(ctx)
    return () => new YahooFantasyService(ctx, { ...h.config, ...overrides })
  }
  for (const overrides of [
    { season: 1999 }, { season: 2026.5 }, { cacheTtlMs: -1 },
    { cacheMaxEntries: 0 }, { retryCount: 6 }, { retryDelayMs: 0 },
    { requestTimeoutMs: 0 }, { lockWaitMs: 0 }, { lockStaleMs: 999 },
  ]) expect(make(overrides)).toThrow('must be an integer')
  for (const redirectUri of ['http://localhost:8080/oauth', 'https://user@localhost:8080/oauth',
    'https://localhost:8080/oauth#fragment']) {
    expect(make({ redirectUri })).toThrow('redirectUri')
  }
  expect(make({ callerTeams: {} })).toThrow('callerTeams')
  expect(make({ callerTeams: { 'Bad Lane': '470.l.809970.t.7' } })).toThrow('preset id')
  expect(make({ callerTeams: { beardy: 'bad' } })).toThrow('team key')
  expect(make({ authPresets: [] })).toThrow('authPresets')
  expect(make({ authPresets: ['missing'] })).toThrow('authPresets')
  const unknown = h.ctx.sessions.create(SessionId('unknown-team'))
  expect(() => h.ctx.fantasy.teamFor(unknown)).toThrow('no team')
  const unmapped = h.ctx.sessions.create(SessionId('unmapped-team'), { meta: { agentPreset: 'unknown' } })
  expect(() => h.ctx.fantasy.teamFor(unmapped)).toThrow('no team')
  const imported = join(h.tokenFile, '..', 'import.json')
  await writeFile(imported, JSON.stringify(h.record), { mode: 0o600 })
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(CommandRuntime)
  expect(new YahooFantasyService(ctx, { ...h.config, importFrom: imported })).toBeInstanceOf(YahooFantasyService)
})

it('bounds the response cache and forwards week, search, and ownership selectors', async () => {
  let gets = 0
  const h = await setup({ config: { cacheMaxEntries: 1 }, fetcher: (input, init, fallback) => {
    if (init?.method === 'GET') gets++
    return fallback(input, init)
  } })
  const league = LeagueKey('470.l.809970')
  await h.ctx.fantasy.leagues()
  await h.ctx.fantasy.leagues()
  expect(gets).toBe(1)
  await h.ctx.fantasy.standings(league)
  await h.ctx.fantasy.leagues()
  expect(gets).toBe(3)
  await h.ctx.fantasy.scoreboard(league)
  expect(await h.ctx.fantasy.matchups(TeamKey('470.l.809970.t.7'), 3)).toHaveLength(1)
  expect(await h.ctx.fantasy.matchups(TeamKey('470.l.809970.t.7'), 4)).toEqual([])
  expect(h.requested.some(path => path.endsWith('/team/470.l.809970.t.7/matchups;weeks=3'))).toBe(true)
  await h.ctx.fantasy.players(league, { search: 'Player One', start: 0, count: 1, week: 3 })
  await h.ctx.fantasy.players(league, { status: 'W', sort: 'percent_owned', start: 0, count: 1 })
  await h.ctx.fantasy.players(league, { status: 'FA', sort: 'points', start: 0, count: 2, week: 3 })
  await h.ctx.fantasy.player(league, PlayerKey('470.p.1'), 3).catch(() => undefined)
  await expect(h.ctx.fantasy.player(league, PlayerKey('470.p.999'))).rejects.toThrow('player unavailable')
  expect(h.requested.some(path => path.includes(';out=percent_owned,ownership/stats;type=week;week=3'))).toBe(true)
  expect(h.requested.some(path => path.includes('sort=PTS;sort_type=week;sort_week=3'))).toBe(true)
  expect(h.requested.every(path => !path.includes('sort=P;'))).toBe(true)
})

it('sorts percent owned within the fetched page, including absent values and ties', async () => {
  const names = ['Zulu', 'Missing', 'Alpha', 'Most']
  const values = [40, undefined, 40, 60]
  const players = Object.fromEntries(names.map((name, index) => [index, {
    player: [[{ player_key: `470.p.${index + 1}` }, { name: { full: name } }],
      ...(values[index] === undefined ? [] : [{ percent_owned: [{ value: values[index] }] }])],
  }]))
  const h = await setup({ fetcher: (input, init, fallback) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    return url.pathname.includes('/players;')
      ? Promise.resolve(new Response(JSON.stringify({ fantasy_content: { league: [{}, { players }] } })))
      : fallback(input, init)
  } })
  const page = await h.ctx.fantasy.players(LeagueKey('470.l.809970'),
    { status: 'FA', sort: 'percent_owned', start: 0, count: 4 })
  expect(page.map(player => player.name)).toEqual(['Most', 'Alpha', 'Zulu', 'Missing'])
})

it('refreshes once after 401 and retries bounded temporary HTTP failures', async () => {
  let getCount = 0
  let tokenCount = 0
  const h = await setup({ config: { retryCount: 1, retryDelayMs: 1 },
    fetcher: (input, init, fallback) => {
      if (init?.method === 'POST') tokenCount++
      if (init?.method === 'GET' && getCount++ === 0) return Promise.resolve(new Response('', { status: 401 }))
      return fallback(input, init)
    } })
  expect(await h.ctx.fantasy.leagues()).toHaveLength(2)
  expect(getCount).toBe(2)
  expect(tokenCount).toBe(1)
  let secondGets = 0
  const second = await setup({ config: { retryCount: 1, retryDelayMs: 1 },
    fetcher: (input, init, fallback) => {
      if (init?.method === 'GET' && [0, 2].includes(secondGets++)) {
        return Promise.resolve(new Response('', {
          status: secondGets === 1 ? 429 : 503,
          headers: secondGets === 1 ? { 'retry-after': '0.001' } : {},
        }))
      }
      return fallback(input, init)
    } })
  expect(await second.ctx.fantasy.leagues()).toHaveLength(2)
  expect(await second.ctx.fantasy.standings(LeagueKey('470.l.809970'))).toHaveLength(10)
})

it('returns safe API errors for transport, JSON, status, and cancellation failures', async () => {
  const league = LeagueKey('470.l.809970')
  const offline = await setup({ fetcher: (_input, init, fallback) => init?.method === 'GET'
    ? Promise.reject(new Error('private fixture transport')) : fallback(_input, init) })
  await expect(offline.ctx.fantasy.leagues()).rejects.toThrow('API unavailable')
  const status = await offline.ctx.commands.execute(offline.agent, '/fantasy status', [], new AbortController().signal)
  expect(status?.result.text).toContain('unreachable')
  expect(status?.result.text).not.toContain('private fixture transport')
  const invalidJson = await setup({ fetcher: (_input, init, fallback) => init?.method === 'GET'
    ? Promise.resolve(new Response('{broken', { status: 200 })) : fallback(_input, init) })
  await expect(invalidJson.ctx.fantasy.leagues()).rejects.toThrow('invalid API response')
  const denied = await setup({ fetcher: (_input, init, fallback) => init?.method === 'GET'
    ? Promise.resolve(new Response('', { status: 403 })) : fallback(_input, init) })
  await expect(denied.ctx.fantasy.standings(league)).rejects.toThrow('HTTP 403')
  const cancelled = new AbortController()
  cancelled.abort()
  await expect(denied.ctx.fantasy.leagues(cancelled.signal)).rejects.toThrow()
})

it('cancels a rate-limit wait when the caller aborts', async () => {
  const controller = new AbortController()
  const h = await setup({ config: { retryCount: 1 },
    fetcher: (input, init, fallback) => init?.method === 'GET'
      ? Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': '1' } }))
      : fallback(input, init) })
  const pending = h.ctx.fantasy.leagues(controller.signal)
  setTimeout(() => { controller.abort() }, 10)
  await expect(pending).rejects.toThrow('request cancelled')
})

it('accepts a pasted code while rejecting missing state, missing code, and unknown commands', async () => {
  const h = await setup()
  const signal = new AbortController().signal
  expect((await h.ctx.commands.execute(h.agent, '/fantasy other', [], signal))?.result.text).toContain('Usage:')
  expect((await h.ctx.commands.execute(h.agent, '/fantasy auth https://localhost:8080/oauth?code=a', [], signal))
    ?.result.kind).toBe('error')
  const start = await h.ctx.commands.execute(h.agent, '/fantasy auth', [], signal)
  const state = new URL(start?.result.text ?? '').searchParams.get('state')
  expect((await h.ctx.commands.execute(h.agent,
    '/fantasy auth https://localhost:8080/oauth?code=a&state=wrong', [], signal))?.result.kind).toBe('error')
  expect((await h.ctx.commands.execute(h.agent,
    `/fantasy auth https://localhost:8080/oauth?state=${state}`, [], signal))?.result.kind).toBe('error')
  expect((await h.ctx.commands.execute(h.agent, '/fantasy auth bad code', [], signal))?.result.kind).toBe('error')
  expect((await h.ctx.commands.execute(h.agent, '/fantasy auth private-code', [], signal))?.result.kind)
    .toBe('success')
  expect(JSON.stringify(h.agent.session.snapshotEvents())).not.toContain('private-code')
})
