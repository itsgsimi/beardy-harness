/** Fixture Yahoo data, a scripted model, fake web providers, and the local research provider for report tests. */

import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { FantasyService } from '@deepseek-ai/dsh-fantasy'
import type {
  FantasyGameWeek, FantasyLeagueSettings, FantasyMatchup, FantasyRoster, LeagueKey, TeamKey,
} from '@deepseek-ai/dsh-fantasy/types'
import { parseGameWeeks, parseLeagueSettings, parseMatchups, parseRoster } from '@deepseek-ai/dsh-fantasy-yahoo'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import LocalResearchService, { type Config as ResearchConfig } from '@deepseek-ai/dsh-research-local'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import WebRuntime from '@deepseek-ai/dsh-web'
import type { WebFetchResult, WebSearchResult } from '@deepseek-ai/dsh-web'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import type { FantasyDraft } from '../src/draft.ts'

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

/** Wednesday of week 3, 2:00 PM in Phoenix. */
export const WEDNESDAY_WEEK_3 = Date.UTC(2026, 8, 23, 21, 0)

/** Mutable fixture data a test may replace before the report reads it. */
export interface FantasyData {
  settings: FantasyLeagueSettings
  roster: FantasyRoster
  matchups: readonly FantasyMatchup[]
  weeks: readonly FantasyGameWeek[]
  failure?: Error
}

/** Fixture-backed Fantasy provider answering only the reads a report makes. */
export class FixtureFantasy extends FantasyService {
  /** Data returned by the next reads. */
  data: FantasyData = { ...yahoo }

  teamFor(): TeamKey { throw new Error('reports never resolve a caller team') }
  async leagues(): Promise<never> { throw new Error('unused') }
  async league(key: LeagueKey): Promise<FantasyLeagueSettings> {
    if (this.data.failure !== undefined) throw this.data.failure
    if (key !== this.data.settings.league.key) throw new Error('unknown league')
    return this.data.settings
  }
  async standings(): Promise<never> { throw new Error('unused') }
  async scoreboard(): Promise<never> { throw new Error('unused') }
  async matchups(): Promise<readonly FantasyMatchup[]> { return this.data.matchups }
  async team(): Promise<FantasyRoster> { return this.data.roster }
  async players(): Promise<never> { throw new Error('unused') }
  async player(): Promise<never> { throw new Error('unused') }
  async transactions(): Promise<never> { throw new Error('unused') }
  async draft(): Promise<never> { throw new Error('unused') }
  async gameWeeks(): Promise<readonly FantasyGameWeek[]> { return this.data.weeks }
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

/** A draft that passes every code check against the fixture pages. */
export function validDraft(): FantasyDraft {
  const starters: Record<string, string> = { P1: 'QB', P2: 'RB', P3: 'RB', P4: 'WR', P5: 'WR', P6: 'TE', P7: 'W/R/T', P14: 'K', P15: 'DEF' }
  return {
    players: rosterIds.map((id, index) => ({
      player: id, recommendation: starters[id] === undefined ? 'SIT' : 'START', confidence: 'medium',
      facts: [{ text: 'Practiced fully on Wednesday.', source: index + 1, quote: 'practiced fully on Wednesday' }],
      reason: `Row ${id}: the practice report supports this choice.`, watch: 'Friday injury report.',
    })),
    lineup: Object.entries(starters).map(([player, slot]) => ({ player, slot })),
    actions: ['Keep the current Yahoo lineup.'],
    decisions: [{ title: 'Flex choice', text: 'Breece Hall keeps the flex over the bench options this week.', sources: [7] }],
    caveats: ['Recheck Friday practice reports.'],
  }
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
} = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'fantasy-reports-'))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(LocalAttachmentStore, { dshHome: root })
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
  const fantasy = ctx.fantasy as FixtureFantasy
  return {
    ctx, root, adapter, fantasy, research: ctx.research as LocalResearchService,
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
