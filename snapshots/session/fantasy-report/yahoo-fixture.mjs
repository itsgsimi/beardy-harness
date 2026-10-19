/** Anonymized Yahoo captures behind the real provider, with a disposable private token store. The opponent's roster
 * capture lives beside this file; the other captures are the provider's test fixtures. The roster capture moves the
 * Steelers' bye to week 4, so the bye outlook shows an empty DEF slot next week. Waiver-pool lists and exact-player
 * reads are assembled from captured player entries: Olamide Zaccheaus is on waivers (a claim), the synthetic Marcus
 * Webb is a free agent, and exact-player reads add the recent weekly points below. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

export const name = 'fantasy-report-yahoo-fixture'
export const inject = ['loader']

/** Waiver-pool lists: a position's season rank list or one earlier week's top scorers. */
const POOL_LIST = /^\/fantasy\/v2\/league\/470\.l\.809970\/players;status=A;position=([A-Z/]+);sort=(AR|PTS)(?:;sort_type=week;sort_week=[0-9]+)?;start=0;count=25;out=percent_owned,ownership\/stats(?:;type=week;week=[0-9]+)?$/u

/** Exact-player reads of one completed week's points. */
const PLAYER_KEYS = /^\/fantasy\/v2\/league\/470\.l\.809970\/players;player_keys=([0-9.p,]+);out=percent_owned,ownership\/stats;type=week;week=([0-9]+)$/u

const RESPONSES = {
  '/fantasy/v2/league/470.l.809970/settings': 'league-settings',
  '/fantasy/v2/league/470.l.809970/standings': 'league-standings',
  '/fantasy/v2/game/nfl/game_weeks': 'game-weeks',
  '/fantasy/v2/team/470.l.809970.t.7/matchups;weeks=3': 'team-matchups',
}

const ROSTER = '/fantasy/v2/team/470.l.809970.t.7/roster;week=3/players/stats;type=week;week=3'

/** Captures stored beside this fixture rather than with the provider's tests. */
const LOCAL_RESPONSES = {
  '/fantasy/v2/team/470.l.809970.t.3/roster;week=3/players/stats;type=week;week=3': 'opponent-roster',
}

/** Actual league points by player name and completed week. */
const RECENT = {
  'Parker Washington': { 1: 20.5, 2: 16.1 },
  'Jahmyr Gibbs': { 1: 18.2, 2: 21.4 },
  'Tyler Warren': { 1: 3.1, 2: 2.4 },
  'Olamide Zaccheaus': { 1: 11.2, 2: 13.8 },
}

function capture(file) {
  return readFile(new URL(`../../../packages/fantasy/fantasy-yahoo/tests/fixtures/${file}.json`, import.meta.url), 'utf8')
}

/** Every `player` entry's metadata fragments, by player key. */
function metadata(raw, into) {
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (value === null || typeof value !== 'object') return
    if (Array.isArray(value.player)) {
      const meta = value.player[0]
      into.set(meta.find(part => part?.player_key !== undefined).player_key, meta)
    }
    Object.values(value).forEach(visit)
  }
  visit(raw.fantasy_content)
  return into
}

function fullName(meta) {
  return meta.find(part => part?.name !== undefined).name.full
}

/** A league players response holding the given player entries. */
function playersResponse(entries) {
  return { fantasy_content: { league: [{ league_key: '470.l.809970' }, {
    players: entries.length === 0 ? []
      : { ...Object.fromEntries(entries.map((player, index) => [String(index), { player }])), count: entries.length },
  }] } }
}

/** A captured player's metadata under another identity, for a free agent the captures do not hold. */
function renamed(meta, key, full, team, bye) {
  const [first, last] = full.split(' ')
  return meta.map((part) => {
    if (part?.player_key !== undefined) return { player_key: key }
    if (part?.player_id !== undefined) return { player_id: key.split('.').at(-1) }
    if (part?.name !== undefined) return { name: { full, first, last, ascii_first: first, ascii_last: last } }
    if (part?.editorial_team_abbr !== undefined) return { editorial_team_abbr: team }
    if (part?.bye_weeks !== undefined) return { bye_weeks: { week: String(bye) } }
    return part
  })
}

/** The adjusted roster capture, the waiver-pool lists by position and sort, and every known player's metadata. */
async function fixtures() {
  const roster = JSON.parse(await capture('team-roster-week-stats'))
  const known = metadata(roster, new Map())
  for (const meta of known.values()) {
    if (fullName(meta) === 'Steelers') meta.find(part => part?.bye_weeks !== undefined).bye_weeks = { week: '4' }
  }
  const available = metadata(JSON.parse(await capture('league-waivers-all')), new Map())
  const backs = metadata(JSON.parse(await capture('league-fa-rb')), new Map())
  const byName = new Map([...available.values(), ...backs.values()].map(meta => [fullName(meta), meta]))
  const zaccheaus = byName.get('Olamide Zaccheaus')
  const webb = renamed(zaccheaus, '470.p.39001', 'Marcus Webb', 'Ten', 10)
  const own = (meta, type, owned) => [meta, { ownership: { ownership_type: type } },
    { percent_owned: [{ coverage_type: 'week', week: 3 }, { value: owned }, { delta: '0' }] }]
  const free = names => names.map(full => own(byName.get(full), 'freeagents', 3))
  const lists = {
    QB: { AR: free(['Tyrod Taylor', 'Cooper Rush']), PTS: [] },
    RB: { AR: [...backs.values()].map(meta => own(meta, 'freeagents', 20)), PTS: [] },
    WR: { AR: [own(zaccheaus, 'waivers', 9), own(webb, 'freeagents', 4)], PTS: [own(zaccheaus, 'waivers', 9)] },
    TE: { AR: free(['Austin Hooper', 'Jonnu Smith']), PTS: [] },
    K: { AR: free(['Nick Folk', 'Brandon McManus']), PTS: [] },
    DEF: { AR: [], PTS: [] },
  }
  for (const [key, meta] of [...available, ...backs, ['470.p.39001', webb]]) known.set(key, meta)
  return { roster, lists, known }
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
  const data = await fixtures()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.origin !== 'https://fantasysports.yahooapis.com' || init?.method !== 'GET'
      || init?.headers?.Authorization !== 'Bearer fixture-access') {
      throw new Error(`unexpected Yahoo fixture request ${url.pathname}`)
    }
    const path = url.pathname
    const pool = POOL_LIST.exec(path)
    const keys = PLAYER_KEYS.exec(path)
    let body
    if (path === ROSTER) {
      body = JSON.stringify(data.roster)
    } else if (pool !== null) {
      body = JSON.stringify(playersResponse(data.lists[pool[1]][pool[2]]))
    } else if (keys !== null) {
      const week = Number(keys[2])
      body = JSON.stringify(playersResponse(keys[1].split(',').map((key) => {
        const meta = data.known.get(key)
        if (meta === undefined) throw new Error(`unexpected Yahoo fixture player ${key}`)
        const points = RECENT[fullName(meta)]?.[week]
        return points === undefined ? [meta]
          : [meta, { player_points: { coverage_type: 'week', week: String(week), total: points.toFixed(2) } }]
      })))
    } else if (LOCAL_RESPONSES[path] !== undefined) {
      body = await readFile(new URL(`./${LOCAL_RESPONSES[path]}.json`, import.meta.url), 'utf8')
    } else if (RESPONSES[path] !== undefined) {
      body = await capture(RESPONSES[path])
    } else {
      throw new Error(`unexpected Yahoo fixture request ${path}`)
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
}
