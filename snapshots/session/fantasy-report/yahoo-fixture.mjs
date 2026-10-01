/** Anonymized Yahoo captures behind the real provider, with a disposable private token store. The opponent's roster
 * capture lives beside this file; the other captures are the provider's test fixtures. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

export const name = 'fantasy-report-yahoo-fixture'
export const inject = ['loader']

/** Free-agent reads at any position answer with the mixed available-player capture. */
const FREE_AGENTS = /^\/fantasy\/v2\/league\/470\.l\.809970\/players;status=FA;position=[A-Z/]+;/u

const RESPONSES = {
  '/fantasy/v2/league/470.l.809970/settings': 'league-settings',
  '/fantasy/v2/game/nfl/game_weeks': 'game-weeks',
  '/fantasy/v2/team/470.l.809970.t.7/roster;week=3/players/stats;type=week;week=3': 'team-roster-week-stats',
  '/fantasy/v2/team/470.l.809970.t.7/matchups;weeks=3': 'team-matchups',
}

/** Captures stored beside this fixture rather than with the provider's tests. */
const LOCAL_RESPONSES = {
  '/fantasy/v2/team/470.l.809970.t.3/roster;week=3/players/stats;type=week;week=3': 'opponent-roster',
}

export async function apply(ctx) {
  const home = resolveDshHome()
  const tokenFile = join(home, 'fantasy-report', 'oauth2.json')
  await mkdir(join(home, 'fantasy-report'), { recursive: true, mode: 0o700 })
  await writeFile(tokenFile, JSON.stringify({
    consumer_key: 'fixture-client', consumer_secret: 'fixture-secret',
    access_token: 'fixture-access', refresh_token: 'fixture-refresh',
    token_type: 'bearer', token_time: 4_000_000_000,
  }), { mode: 0o600 })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    const local = LOCAL_RESPONSES[url.pathname]
    const fixture = local ?? (FREE_AGENTS.test(url.pathname) ? 'league-waivers-all' : RESPONSES[url.pathname])
    if (url.origin !== 'https://fantasysports.yahooapis.com' || fixture === undefined
      || init?.method !== 'GET' || init?.headers?.Authorization !== 'Bearer fixture-access') {
      throw new Error(`unexpected Yahoo fixture request ${url.pathname}`)
    }
    const body = await readFile(new URL(local === undefined
      ? `../../../packages/fantasy/fantasy-yahoo/tests/fixtures/${fixture}.json` : `./${fixture}.json`, import.meta.url), 'utf8')
    return new Response(body, { status: 200 })
  }
  ctx.effect(() => () => { globalThis.fetch = originalFetch }, 'Yahoo fixture transport')
  await ctx.loader.create({
    name: '@deepseek-ai/dsh-fantasy-yahoo',
    config: {
      tokenFile, redirectUri: 'https://localhost:8080/oauth', season: 2026,
      callerTeams: { headless: '470.l.809970.t.7' }, authPresets: ['headless'],
    },
  })
}
