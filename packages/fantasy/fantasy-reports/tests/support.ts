/** Fixture Yahoo data and projections, a scripted model, fake web providers, and the local research provider for report tests. */

import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { FantasyNflService, FantasyProjectionService, FantasyService, PlayerKey } from '@deepseek-ai/dsh-fantasy'
import type {
  FantasyGameWeek, FantasyLeagueSettings, FantasyMatchup, FantasyNflGame, FantasyNflUsage, FantasyPlayer, FantasyRoster, FantasyTeam,
  LeagueKey, PlayerKey as PlayerId, TeamKey,
} from '@deepseek-ai/dsh-fantasy/types'
import { parseGameWeeks, parseLeagueSettings, parseMatchups, parsePlayers, parseRoster } from '@deepseek-ai/dsh-fantasy-yahoo'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import LocalResearchService, { type Config as ResearchConfig } from '@deepseek-ai/dsh-research-local'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import WebRuntime from '@deepseek-ai/dsh-web'
import type { WebFetchResult, WebSearchResult } from '@deepseek-ai/dsh-web'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { DATA_MARKER } from '../src/prompts.ts'

const fixtureRoot = new URL('../../fantasy-yahoo/tests/fixtures/', import.meta.url)

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`${name}.json`, fixtureRoot), 'utf8'))
}

/** Anonymized Yahoo captures: 10-team league, week 3, the reported team's 15-player roster. */
export const yahoo = {
  settings: parseLeagueSettings(fixture('league-settings')),
  roster: parseRoster(fixture('team-roster-week-stats')),
  matchups: parseMatchups(fixture('team-matchups')),
  weeks: parseGameWeeks(fixture('game-weeks')),
  /** Ten free-agent running backs of the same league. */
  freeAgentBacks: parsePlayers(fixture('league-fa-rb')),
  /** Ten available players of mixed positions. */
  available: parsePlayers(fixture('league-waivers-all')),
}

/** Short roster ids in roster order. */
export const rosterIds = yahoo.roster.players.map((_, index) => `P${index + 1}`)

/**
 * The week 3 roster capture with Yahoo's `is_editable` set to 0 for the given roster indexes, as Yahoo
 * returns it once those players' games have started.
 * @param indexes - zero-based roster positions whose slots are locked.
 * @returns the parsed roster.
 */
export function lockedRoster(indexes: readonly number[]): FantasyRoster {
  const raw = fixture('team-roster-week-stats') as { fantasy_content: { team: [unknown, { roster: Record<string, unknown> }] } }
  const players = (raw.fantasy_content.team[1].roster['0'] as { players: Record<string, { player: unknown[] }> }).players
  for (const index of indexes) (players[String(index)]!.player[2] as { is_editable: number }).is_editable = 0
  return parseRoster(raw)
}

/**
 * A synthetic player whose key derives from its name.
 * @param name - display name.
 * @param positions - Yahoo eligible positions.
 * @param extra - other Yahoo fields.
 * @returns the player.
 */
export function synthetic(name: string, positions: string[], extra: Partial<FantasyPlayer> = {}): FantasyPlayer {
  const code = Array.from({ length: name.length }, (_, index) => name.charCodeAt(index))
    .reduce((sum, char) => (sum * 31 + char) % 1_000_003, 7)
  return { key: PlayerKey(`470.p.${code}`), name, positions, ...extra }
}

/** Wednesday of week 3, 2:00 PM in Phoenix. */
export const WEDNESDAY_WEEK_3 = Date.UTC(2026, 8, 23, 21, 0)

/** Mutable fixture data a test may replace before the report reads it. */
export interface FantasyData {
  settings: FantasyLeagueSettings
  roster: FantasyRoster
  matchups: readonly FantasyMatchup[]
  weeks: readonly FantasyGameWeek[]
  failure?: Error
  /** Available players of a position's season rank list; a missing position returns none. */
  freeAgents?: Readonly<Record<string, readonly FantasyPlayer[]>>
  /** Available players of a position's points list for any earlier week; a missing position returns none. */
  scorers?: Readonly<Record<string, readonly FantasyPlayer[]>>
  /** Error thrown by available-player list reads. */
  freeAgentFailure?: Error
  /** Standings; absent, the reported team alone with waiver priority 4. */
  standings?: readonly FantasyTeam[]
  /** Error thrown by standings reads. */
  standingsFailure?: Error
  /** Actual points by player name and week answered by exact-player reads. */
  recentPoints?: Readonly<Record<string, Readonly<Record<number, number>>>>
  /** Error thrown by exact-player reads. */
  recentFailure?: Error
  /** Roster returned for any other team; reading one throws when absent. */
  opponent?: FantasyRoster
}

/** Fixture-backed Fantasy provider answering only the reads a report makes. */
export class FixtureFantasy extends FantasyService {
  /** Data returned by the next reads. */
  data: FantasyData = { settings: yahoo.settings, roster: yahoo.roster, matchups: yahoo.matchups, weeks: yahoo.weeks }
  /** Positions of every available-player list read, in order. */
  readonly freeAgentReads: string[] = []
  /** Week and player count of every exact-player read, in order. */
  readonly keyReads: Array<{ week: number; count: number }> = []

  teamFor(): TeamKey { throw new Error('reports never resolve a caller team') }
  async leagues(): Promise<never> { throw new Error('unused') }
  async league(key: LeagueKey): Promise<FantasyLeagueSettings> {
    if (this.data.failure !== undefined) throw this.data.failure
    if (key !== this.data.settings.league.key) throw new Error('unknown league')
    return this.data.settings
  }
  async standings(): Promise<readonly FantasyTeam[]> {
    if (this.data.standingsFailure !== undefined) throw this.data.standingsFailure
    return this.data.standings ?? [{ ...this.data.roster.team, waiverPriority: 4 }]
  }
  async scoreboard(): Promise<never> { throw new Error('unused') }
  async matchups(): Promise<readonly FantasyMatchup[]> { return this.data.matchups }
  /** The opponent's roster for the matchup opponent's key; the reported roster for any other key. */
  async team(key: TeamKey): Promise<FantasyRoster> {
    const opponent = this.data.matchups[0]?.teams.find(team => team.key !== this.data.roster.team.key)?.key
    if (key !== opponent) return this.data.roster
    if (this.data.opponent === undefined) throw new Error('opponent roster unavailable')
    return this.data.opponent
  }
  async players(_league: LeagueKey,
    query: { position?: string; sort?: string; week?: number; playerKeys?: readonly PlayerId[] }): Promise<readonly FantasyPlayer[]> {
    if (query.playerKeys !== undefined) {
      this.keyReads.push({ week: query.week as number, count: query.playerKeys.length })
      if (this.data.recentFailure !== undefined) throw this.data.recentFailure
      const known = [...this.data.roster.players, ...Object.values(this.data.freeAgents ?? {}).flat(),
        ...Object.values(this.data.scorers ?? {}).flat()]
      return query.playerKeys.map((key): FantasyPlayer => {
        const { points: _points, ...player } = known.find(item => item.key === key) as FantasyPlayer
        const points = this.data.recentPoints?.[player.name]?.[query.week as number]
        return points === undefined ? player : { ...player, points }
      })
    }
    this.freeAgentReads.push(query.position as string)
    if (this.data.freeAgentFailure !== undefined) throw this.data.freeAgentFailure
    const lists = query.sort === 'points' ? this.data.scorers : this.data.freeAgents
    return lists?.[query.position as string] ?? []
  }
  async player(): Promise<never> { throw new Error('unused') }
  async transactions(): Promise<never> { throw new Error('unused') }
  async draft(): Promise<never> { throw new Error('unused') }
  async gameWeeks(): Promise<readonly FantasyGameWeek[]> { return this.data.weeks }
}

/** NFL data provider answering from fixed games and usage rows. */
export class FixtureNfl extends FantasyNflService {
  /** Games by week. */
  schedule: Readonly<Record<number, readonly FantasyNflGame[]>> = {}
  /** Usage rows by player name. */
  usageRows: Readonly<Record<string, readonly FantasyNflUsage[]>> = {}
  /** Error thrown by every read. */
  failure?: Error
  /** Weeks of every usage read, in order. */
  readonly usageReads: number[][] = []

  async games(_season: number, week: number): Promise<readonly FantasyNflGame[]> {
    if (this.failure !== undefined) throw this.failure
    return this.schedule[week] ?? []
  }

  async usage(_season: number, weeks: readonly number[],
    players: readonly FantasyPlayer[]): Promise<ReadonlyMap<PlayerId, readonly FantasyNflUsage[]>> {
    this.usageReads.push([...weeks])
    return new Map(players.flatMap(player => this.usageRows[player.name] === undefined ? []
      : [[player.key, this.usageRows[player.name] as readonly FantasyNflUsage[]] as const]))
  }
}

/** Projection provider answering from stat lines keyed by player name; no line is the default. */
export class FixtureProjections extends FantasyProjectionService {
  /** Stat lines by player name. */
  lines: Readonly<Record<string, Readonly<Record<string, number>>>> = {}
  /** Error thrown by every projection read. */
  failure?: Error
  /** Season, week, and player names of every read, in order. */
  readonly reads: Array<{ season: number; week: number; names: string[] }> = []

  async project(season: number, week: number,
    players: readonly FantasyPlayer[]): Promise<ReadonlyMap<PlayerId, Readonly<Record<string, number>>>> {
    this.reads.push({ season, week, names: players.map(player => player.name) })
    if (this.failure !== undefined) throw this.failure
    return new Map(players.flatMap((player) => {
      const line = this.lines[player.name]
      return line === undefined ? [] : [[player.key, line] as const]
    }))
  }
}

/** One page per player: `https://news.example/p<N>` names the player and states a practice fact. */
export function playerPage(index: number): { url: string; text: string } {
  const player = yahoo.roster.players[index]!
  return {
    url: `https://news.example/p${index + 1}`,
    text: `Week 3 notes. ${player.name} practiced fully on Wednesday and is expected to play this week.`,
  }
}

/** Search answering every player query with that player's page. */
export async function playerSearch(query: string): Promise<WebSearchResult> {
  const index = yahoo.roster.players.findIndex(player => query.includes(player.name))
  return { sources: index < 0 ? [] : [{ url: playerPage(index).url, title: `Player ${index + 1} news` }], truncated: false }
}

/** Fetch serving {@link playerPage} bodies. */
export async function playerFetch(url: string): Promise<WebFetchResult> {
  const index = Number(/p([0-9]+)$/u.exec(url)?.[1]) - 1
  return { url, statusCode: 200, body: { kind: 'text', content: playerPage(index).text }, truncated: false }
}

/** Stage names as each stage prompt's first line states them. */
export type StageName = 'player calls' | 'close calls' | 'waiver picks' | 'summary' | 'reason check'

/** A player's fact sheet as stage data shows it. */
export interface SheetData {
  readonly id: string
  readonly name: string
  readonly codeCall: string
  readonly excerpts: ReadonlyArray<{ readonly source: number; readonly text: string }>
}

/** The parts of a stage data block the test answers read. */
export interface StageData {
  readonly players?: readonly SheetData[]
  readonly pairs?: ReadonlyArray<{ readonly id: string; readonly starter: SheetData; readonly bench: SheetData }>
  readonly candidates?: ReadonlyArray<{ readonly id: string }>
}

/**
 * Name and data block of the stage request: the first user message of its Session, so a corrective
 * turn still names its stage.
 * @param request - model request.
 * @returns stage name and parsed data block.
 */
export function stageOf(request: GenerateOptions): { stage: StageName; data: StageData } {
  const first = request.messages.find(item => item.role === 'user'
    && item.content.some(block => block.type === 'text' && block.text.startsWith('Stage: ')))
  const text = first?.content.map(block => block.type === 'text' ? block.text : '').join('') ?? ''
  const data = JSON.parse(text.slice(text.lastIndexOf(DATA_MARKER) + DATA_MARKER.length)) as StageData
  return { stage: /^Stage: ([a-z ]+)\./u.exec(text)?.[1] as StageName, data }
}

/** Valid default answers: every player keeps the code call and cites his first excerpt. */
const ANSWERS: Readonly<Record<StageName, (data: StageData) => unknown>> = {
  'player calls': data => Object.fromEntries(data.players!.map(sheet => [sheet.id, {
    call: sheet.codeCall, reason: `${sheet.name} keeps the code call.`,
    sources: sheet.excerpts.slice(0, 1).map(item => item.source) }])),
  'close calls': data => Object.fromEntries(data.pairs!.map(pair => [pair.id, {
    text: `${pair.starter.name} stays ahead of ${pair.bench.name} this week.`, sources: [] }])),
  'waiver picks': data => ({ picks: [{ id: data.candidates![0]!.id, reason: 'The best available fill-in.' }] }),
  'summary': () => ({ summary: 'The Googies keep their Yahoo lineup this week. Recheck the questionable starters on Friday.' }),
  'reason check': () => ({ unsupported: [] }),
}

/**
 * A model that answers each stage from its own prompt data; overrides replace one stage's answer.
 * @param overrides - answers by stage; a string is sent verbatim.
 * @returns a reply usable for any number of stage requests.
 */
export function stageModel(overrides: Partial<Record<StageName, (data: StageData, request: GenerateOptions) => unknown>> = {}): Reply {
  return (request) => {
    const { stage, data } = stageOf(request)
    const answer = (overrides[stage] ?? ANSWERS[stage])(data, request)
    return typeof answer === 'string' ? answer : JSON.stringify(answer)
  }
}

/**
 * Enough automatic replies for every stage of one or more reports.
 * @param reply - reply used for every request.
 * @param count - number of requests answered.
 * @returns a script for {@link harness}.
 */
export function replies(reply: Reply = stageModel(), count = 40): Reply[] {
  return Array.from({ length: count }, () => reply)
}

/** Script entry for a stage that never answers until its run is cancelled. */
export const HANG = Symbol('hang')

/** Scripted model entry: fixed text, text computed from the request, or a hang. */
export type Reply = string | ((options: GenerateOptions) => string) | typeof HANG

/** A running test Context with the local research provider and fixture services. */
export interface Harness {
  readonly ctx: Context
  readonly root: string
  readonly adapter: MockAdapter
  readonly fantasy: FixtureFantasy
  readonly projections: FixtureProjections
  /** The fixture NFL data provider, when mounted. */
  readonly nfl: FixtureNfl | undefined
  readonly research: LocalResearchService
  dispose(): Promise<void>
}

/**
 * Mount the research stack with scripted model replies and fixture web and Yahoo providers.
 * @param replies - model replies in call order.
 * @param options - web behavior and research provider overrides.
 * @returns the harness.
 */
export async function harness(replies: readonly Reply[], options: {
  search?: (query: string, signal?: AbortSignal) => Promise<WebSearchResult>
  fetch?: (url: string) => Promise<WebFetchResult>
  research?: Partial<ResearchConfig>
  /** Mount the fixture NFL data provider. */
  nfl?: boolean
} = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'fantasy-reports-'))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(LocalAttachmentStore, { dshHome: root })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(WebRuntime, { searchProvider: 'test', fetchProvider: 'test' })
  const search = options.search ?? playerSearch
  const fetch = options.fetch ?? playerFetch
  ctx.web.registerSearchProvider({ id: 'test', available: () => true, search: (request, signal) => search(request.query, signal) })
  ctx.web.registerFetchProvider({ id: 'test', available: () => true, fetch: request => fetch(request.url) })
  const adapter = new MockAdapter(replies.map(reply => reply === HANG ? 'hang' as const : typeof reply === 'string'
    ? textResponse(reply) : (request: GenerateOptions): StreamChunk[] => textResponse(reply(request))))
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalResearchService, options.research?.ownerScope === 'session'
    ? { provider: 'mock', model: 'test-model', ownerScope: 'session' }
    : { provider: 'mock', model: 'test-model', ownerScope: 'profile', ownerNamespace: 'beardy', ...options.research })
  await ctx.plugin(FixtureFantasy)
  await ctx.plugin(FixtureProjections)
  if (options.nfl === true) await ctx.plugin(FixtureNfl)
  const fantasy = ctx.fantasy as FixtureFantasy
  return {
    ctx, root, adapter, fantasy, projections: ctx.fantasyProjections as FixtureProjections, research: ctx.research as LocalResearchService,
    nfl: options.nfl === true ? ctx.fantasyNfl as FixtureNfl : undefined,
    async dispose() {
      try {
        await ctx.fiber.dispose()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  }
}

/** Last user prompt text of a model request. */
export function promptOf(request: GenerateOptions): string {
  const message = request.messages.findLast(item => item.role === 'user'
    && item.content.some(block => block.type === 'text' && !block.text.startsWith('Current runtime context')))
  return message?.content.map(block => block.type === 'text' ? block.text : '').join('') ?? ''
}
