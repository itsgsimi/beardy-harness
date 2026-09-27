/** Deterministic Yahoo transport and disposable private store for a model tool replay. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

export const name = 'fantasy-read-fixture'
export const inject = ['loader']

export async function apply(ctx) {
  const home = resolveDshHome()
  const tokenFile = join(home, 'fantasy-read', 'oauth2.json')
  await mkdir(join(home, 'fantasy-read'), { recursive: true, mode: 0o700 })
  await writeFile(tokenFile, JSON.stringify({
    consumer_key: 'fixture-client', consumer_secret: 'fixture-secret',
    access_token: 'fixture-access', refresh_token: 'fixture-refresh',
    token_type: 'bearer', token_time: 4_000_000_000,
  }), { mode: 0o600 })
  const body = await readFile(new URL('../../../packages/fantasy/fantasy-yahoo/tests/fixtures/user-leagues.json',
    import.meta.url), 'utf8')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.origin !== 'https://fantasysports.yahooapis.com'
      || !url.pathname.includes('/users;use_login=1/games;game_codes=nfl;seasons=2026/leagues')
      || init?.method !== 'GET' || init?.headers?.Authorization !== 'Bearer fixture-access') {
      throw new Error('unexpected Yahoo fixture request')
    }
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
  await ctx.loader.create({ name: '@deepseek-ai/dsh-tool-fantasy' })
}
