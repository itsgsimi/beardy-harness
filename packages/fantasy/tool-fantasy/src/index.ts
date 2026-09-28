/** Bounded model-facing Yahoo Fantasy reads. @module @deepseek-ai/dsh-tool-fantasy */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LeagueKey, PlayerKey, TeamKey } from '@deepseek-ai/dsh-fantasy'
import { defineTool, TEXT_TOOL_OUTPUT } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

/** Cordis plugin identity. */
export const name = 'tool-fantasy'
/** The service and model tool registry must exist. */
export const inject = ['fantasy', 'tools']

/** Model-result page bound. */
export interface Config {
  /** Maximum Unicode data characters returned in one model result page. */
  readonly pageChars?: number
}
/** Validated model-result page bound. */
export const Config: z<Config> = z.object({
  pageChars: z.number().step(1).min(100).max(32_000).default(8_000),
})

/** One read operation and its optional selector. */
export interface FantasyToolRequest {
  readonly action: 'leagues' | 'league' | 'standings' | 'scoreboard' | 'matchup'
    | 'team' | 'players' | 'player' | 'transactions' | 'draft' | 'weeks'
  readonly league?: string
  readonly team?: string
  readonly player?: string
  readonly week?: number
  readonly search?: string
  readonly availability?: 'FA' | 'W'
  readonly position?: string
  readonly sort?: 'points' | 'rank' | 'percent_owned'
  readonly start?: number
  readonly count?: number
  readonly offset?: number
}

function natural(value: number, label: string, max: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`fantasy: ${label} must be an integer from 0 through ${max}`)
  }
  return value
}

function page(value: unknown, offset: number, pageChars: number): string {
  const chars = Array.from(JSON.stringify(value))
  if (offset > chars.length) throw new Error('fantasy: offset exceeds response length')
  const end = Math.min(offset + pageChars, chars.length)
  return JSON.stringify({
    text: chars.slice(offset, end).join(''),
    next_offset: end < chars.length ? end : null,
    total_chars: chars.length,
  })
}

/** Execute one model read; the caller Session, never a model field, selects "my team".
 * @param ctx - scoped Fantasy provider.
 * @param args - validated model read request.
 * @param exec - caller agent and cancellation.
 * @param pageChars - maximum data characters in one result.
 * @returns bounded serialized response page.
 */
export async function executeFantasy(
  ctx: Context, args: FantasyToolRequest, exec: ToolRunContext, pageChars: number,
): Promise<{ text: string }> {
  const caller = exec.agent?.session
  if (caller === undefined) throw new Error('fantasy requires a caller Session')
  exec.signal.throwIfAborted()
  const offset = natural(args.offset ?? 0, 'offset', 1_000_000)
  const week = args.week === undefined ? undefined : natural(args.week, 'week', 30)
  if (week === 0) throw new Error('fantasy: week must be positive')
  const start = natural(args.start ?? 0, 'start', 10_000)
  const count = natural(args.count ?? 10, 'count', 25)
  if (count === 0) throw new Error('fantasy: count must be positive')
  const myTeam = (): ReturnType<typeof TeamKey> => ctx.fantasy.teamFor(caller)
  const league = (): ReturnType<typeof LeagueKey> => args.league === undefined
    ? LeagueKey((args.team === undefined || args.team === 'my' ? myTeam() : TeamKey(args.team)).replace(/\.t\.[0-9]+$/u, ''))
    : LeagueKey(args.league)
  let value: unknown
  switch (args.action) {
    case 'leagues': value = await ctx.fantasy.leagues(exec.signal); break
    case 'league': value = await ctx.fantasy.league(league(), exec.signal); break
    case 'standings': value = await ctx.fantasy.standings(league(), exec.signal); break
    case 'scoreboard': value = await ctx.fantasy.scoreboard(league(), week, exec.signal); break
    case 'matchup': value = await ctx.fantasy.matchups(args.team === undefined || args.team === 'my' ? myTeam() : TeamKey(args.team), week, exec.signal); break
    case 'team': {
      const key = args.team === undefined || args.team === 'my' ? myTeam() : TeamKey(args.team)
      if (week === undefined) throw new Error('fantasy: team requires a week')
      value = await ctx.fantasy.team(key, week, exec.signal)
      break
    }
    case 'players': {
      if (args.search !== undefined && (args.search.trim() === '' || args.search.length > 100)) {
        throw new Error('fantasy: search must contain 1 to 100 characters')
      }
      if (args.position !== undefined && !/^[A-Z/]{1,8}$/u.test(args.position)) {
        throw new Error('fantasy: invalid position')
      }
      if (args.search === undefined && args.availability === undefined) {
        throw new Error('fantasy: players requires search or availability')
      }
      const players = await ctx.fantasy.players(league(), {
        start, count,
        ...(args.search === undefined ? {} : { search: args.search.trim() }),
        ...(args.availability === undefined ? {} : { status: args.availability }),
        ...(args.position === undefined ? {} : { position: args.position }),
        ...(args.sort === undefined ? {} : { sort: args.sort }),
        ...(week === undefined ? {} : { week }),
      }, exec.signal)
      value = { players, start, next_start: players.length === count ? start + count : null,
        sort_scope: args.sort === undefined ? 'none' : args.sort === 'percent_owned' ? 'page' : 'league' }
      break
    }
    case 'player': {
      if (args.player === undefined) throw new Error('fantasy: player requires a player key')
      value = await ctx.fantasy.player(league(), PlayerKey(args.player), week, exec.signal)
      break
    }
    case 'transactions': {
      const transactions = await ctx.fantasy.transactions(league(), start, count, exec.signal)
      value = { transactions, start, next_start: transactions.length === count ? start + count : null }
      break
    }
    case 'draft': value = await ctx.fantasy.draft(league(), exec.signal); break
    case 'weeks': value = await ctx.fantasy.gameWeeks(exec.signal); break
    default: {
      const exhaustive: never = args.action
      throw new Error(`fantasy: unknown action ${String(exhaustive)}`)
    }
  }
  return { text: page(value, offset, pageChars) }
}

/** Register a single read-only Fantasy tool; disposal removes its schema. */
export function apply(ctx: Context, config: Config = {}): void {
  const pageChars = config.pageChars ?? 8_000
  if (!Number.isSafeInteger(pageChars) || pageChars < 100 || pageChars > 32_000) {
    throw new Error('tool-fantasy: pageChars must be an integer from 100 through 32000')
  }
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'fantasy',
    description: 'Read Yahoo Fantasy leagues, scoring rules, standings, weekly matchups and projections, rosters, '
      + 'players, free agents, waivers, transactions, draft picks, and game weeks. '
      + 'Use team without a key for the caller\'s configured team. For players, set search or availability. '
      + 'Use start/count for Yahoo result pages and next_offset to read every part of a long response. '
      + 'Percent-owned sorting applies within each returned page. '
      + 'This tool cannot change lineups, claims, or trades. Check current injury news separately.',
    parameters: {
      action: { type: 'string', required: true, enum: [
        'leagues', 'league', 'standings', 'scoreboard', 'matchup', 'team', 'players', 'player', 'transactions', 'draft', 'weeks',
      ] },
      league: { type: 'string', description: 'League key; defaults to the caller\'s configured team league.' },
      team: { type: 'string', description: 'Team key for matchup or roster; omit or use my for the caller\'s team.' },
      player: { type: 'string', description: 'Player key required for player details.' },
      week: { type: 'integer', description: 'Scoring week; required for team roster.' },
      search: { type: 'string', description: 'Player name query for players.' },
      availability: { type: 'string', enum: ['FA', 'W'], description: 'Free agents or waiver players.' },
      position: { type: 'string', description: 'Position filter for players, for example RB or WR.' },
      sort: { type: 'string', enum: ['points', 'rank', 'percent_owned'] },
      start: { type: 'integer', description: 'Yahoo result offset, starting at zero.' },
      count: { type: 'integer', description: 'Yahoo result count, from 1 through 25; defaults to 10.' },
      offset: { type: 'integer', description: 'Character offset into this response; follow next_offset.' },
    },
    output: TEXT_TOOL_OUTPUT,
    execute: (args, exec) => executeFantasy(ctx, args, exec, pageChars),
    presentCall: args => ({ card: 'generic', title: 'Fantasy',
      kind: 'read', rawInput: JSON.stringify(args) }),
  })), 'fantasy tool registration')
}
