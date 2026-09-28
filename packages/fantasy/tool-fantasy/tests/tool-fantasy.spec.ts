import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { FantasyService, LeagueKey, PlayerKey, TeamKey } from '@deepseek-ai/dsh-fantasy'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { executeFantasy } from '../src/index.ts'
import * as ToolFantasy from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

it('validates caller-owned keys and requires a concrete provider', () => {
  expect(() => LeagueKey('bad')).toThrow('league key')
  expect(() => TeamKey('bad')).toThrow('team key')
  expect(() => PlayerKey('bad')).toThrow('player key')
  expect(() => { Reflect.construct(FantasyService, [new Context()]) }).toThrow('load a fantasy provider')
})

it('registers its documented default page bound directly', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ToolFantasy.apply(ctx)
  expect(ctx.tools.schemas().map(schema => schema.name)).toContain('fantasy')
})

async function setup(pageChars?: number) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const team = TeamKey('470.l.809970.t.6')
  const league = LeagueKey('470.l.809970')
  const player = { key: PlayerKey('470.p.1'), name: 'Player One', positions: ['RB'], percentOwned: 25 }
  const started = { key: PlayerKey('470.p.2'), name: 'Player Two', positions: ['WR'], selectedSlot: 'WR', slotLocked: true }
  const service = {
    teamFor: vi.fn(() => team),
    leagues: vi.fn(async () => [{ key: league, name: 'League One' }]),
    league: vi.fn(async () => ({ league: { key: league, name: 'League One' }, rosterSlots: [], scoring: [] })),
    standings: vi.fn(async () => [{ key: team, name: 'Team Six', rank: 1 }]),
    scoreboard: vi.fn(async () => [{ week: 3, teams: [{ key: team, name: 'Team Six', projectedPoints: 110 }] }]),
    matchups: vi.fn(async () => [{ week: 3, teams: [{ key: team, name: 'Team Six' }] }]),
    team: vi.fn(async () => ({ team: { key: team, name: 'Team Six' }, week: 3, players: [player, started] })),
    players: vi.fn(async () => [player]),
    player: vi.fn(async () => player),
    transactions: vi.fn(async () => [{ key: 'tr.1', type: 'add', players: [] }]),
    draft: vi.fn(async () => [{ pick: 1, round: 1, teamKey: team, playerKey: player.key }]),
    gameWeeks: vi.fn(async () => [{ week: 3, start: '2026-09-22', end: '2026-09-28' }]),
  }
  ctx.provide('fantasy' as never, service as never)
  const fiber = await ctx.plugin(ToolFantasy, pageChars === undefined ? {} : { pageChars })
  const scope = ctx.plugin(() => {})
  const session = Session.create(SessionId('fantasy-tool'))
  const agent: Agent = {
    id: session.id, options: {}, session, inbox: unsupportedInbox(), status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(agent)
  const call = async (args: ToolFantasy.FantasyToolRequest) =>
    ctx.tools.execute({ name: 'fantasy', arguments: args, callId: ToolCallId('fantasy-call'), agent,
      signal: new AbortController().signal })
  return { ctx, service, fiber, agent, call }
}

function resultText(result: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['call']>>): string {
  expect(result.isError).toBe(false)
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error('expected text result')
  return block.text
}

it('exposes all requested read actions and derives the caller team without a model identity field', async () => {
  const h = await setup()
  const schema = h.ctx.tools.schemas().find(item => item.name === 'fantasy')
  expect(schema?.parameters.properties).not.toHaveProperty('caller')
  expect(schema?.description).toContain('cannot change lineups')
  for (const args of [
    { action: 'leagues' }, { action: 'league' }, { action: 'standings' },
    { action: 'scoreboard', week: 3 }, { action: 'matchup', week: 3 },
    { action: 'team', week: 3 }, { action: 'players', availability: 'FA', position: 'RB', sort: 'rank' },
    { action: 'player', player: '470.p.1' }, { action: 'transactions' },
    { action: 'draft' }, { action: 'weeks' },
  ] as const) {
    const response = JSON.parse(resultText(await h.call(args))) as { text: string }
    expect(response.text.length).toBeGreaterThan(0)
  }
  expect(h.service.team).toHaveBeenCalledWith(TeamKey('470.l.809970.t.6'), 3, expect.any(AbortSignal))
  expect(schema?.description).toContain('slotLocked true cannot change lineup slots')
  const roster = JSON.parse((JSON.parse(resultText(await h.call({ action: 'team', week: 3 }))) as { text: string }).text) as {
    players: { name: string; slotLocked?: boolean }[]
  }
  expect(roster.players.map(item => [item.name, item.slotLocked])).toEqual([['Player One', undefined], ['Player Two', true]])
  expect(h.service.players).toHaveBeenCalledWith(LeagueKey('470.l.809970'),
    expect.objectContaining({ status: 'FA', position: 'RB', sort: 'rank', count: 10 }), expect.any(AbortSignal))
  await h.fiber.dispose()
  expect(h.ctx.tools.schemas().map(item => item.name)).not.toContain('fantasy')
})

it('pages a long response and rejects invalid or write-shaped model requests', async () => {
  const h = await setup(100)
  const longMatchup = [{ week: 3, teams: [{ key: TeamKey('470.l.809970.t.6'),
    name: 'Team ' + 'X'.repeat(200), projectedPoints: 110 }] }]
  h.service.scoreboard.mockResolvedValue(longMatchup)
  const first = JSON.parse(resultText(await h.call({ action: 'scoreboard', week: 3 }))) as {
    text: string
    next_offset: number
    total_chars: number
  }
  expect(first.next_offset).toBe(100)
  const last = JSON.parse(resultText(await h.call({ action: 'scoreboard', week: 3, offset: first.next_offset }))) as {
    text: string
    next_offset: number | null
  }
  let serialized = first.text + last.text
  let next = last.next_offset
  while (next !== null) {
    const part = JSON.parse(resultText(await h.call({ action: 'scoreboard', week: 3, offset: next }))) as {
      text: string
      next_offset: number | null
    }
    serialized += part.text
    next = part.next_offset
  }
  expect(JSON.parse(serialized)).toEqual(longMatchup)
  const exec = { agent: h.agent, signal: new AbortController().signal } as Parameters<typeof executeFantasy>[2]
  await expect(executeFantasy(h.ctx, { action: 'team' }, exec, 100)).rejects.toThrow('requires a week')
  await expect(executeFantasy(h.ctx, { action: 'players' }, exec, 100)).rejects.toThrow('search or availability')
  await expect(executeFantasy(h.ctx, { action: 'players', availability: 'FA', count: 26 }, exec, 100))
    .rejects.toThrow('count')
  await expect(executeFantasy(h.ctx, { action: 'player', player: 'bad' }, exec, 100)).rejects.toThrow('player key')
  await expect(executeFantasy(h.ctx, { action: 'auth' as ToolFantasy.FantasyToolRequest['action'] }, exec, 100))
    .rejects.toThrow('unknown action')
})

it('uses explicit team and league selectors and forwards every player filter', async () => {
  const h = await setup()
  const exec = { agent: h.agent, signal: new AbortController().signal } as Parameters<typeof executeFantasy>[2]
  const league = '470.l.809970'
  const team = '470.l.809970.t.7'
  await executeFantasy(h.ctx, { action: 'scoreboard', league, week: 4 }, exec, 8_000)
  expect(h.service.scoreboard).toHaveBeenCalledWith(LeagueKey(league), 4, exec.signal)
  await executeFantasy(h.ctx, { action: 'matchup', team: 'my', week: 4 }, exec, 8_000)
  await executeFantasy(h.ctx, { action: 'matchup', team, week: 4 }, exec, 8_000)
  expect(h.service.matchups).toHaveBeenLastCalledWith(TeamKey(team), 4, exec.signal)
  await executeFantasy(h.ctx, { action: 'team', team, week: 4 }, exec, 8_000)
  expect(h.service.team).toHaveBeenLastCalledWith(TeamKey(team), 4, exec.signal)
  await executeFantasy(h.ctx, { action: 'league', team: 'my' }, exec, 8_000)
  await executeFantasy(h.ctx, { action: 'league', team }, exec, 8_000)
  expect(h.service.league).toHaveBeenLastCalledWith(LeagueKey(league), exec.signal)
  const result = await executeFantasy(h.ctx, { action: 'players', team: 'my', search: ' Player One ',
    availability: 'W', position: 'RB', sort: 'points', week: 4, start: 5, count: 1 }, exec, 8_000)
  expect(h.service.players).toHaveBeenCalledWith(LeagueKey(league), {
    search: 'Player One', status: 'W', position: 'RB', sort: 'points', week: 4, start: 5, count: 1,
  }, exec.signal)
  const playerPage = JSON.parse(result.text) as { text: string }
  expect((JSON.parse(playerPage.text) as { next_start: number | null }).next_start).toBe(6)
  const owned = await executeFantasy(h.ctx,
    { action: 'players', availability: 'FA', sort: 'percent_owned' }, exec, 8_000)
  const ownedPage = JSON.parse(owned.text) as { text: string }
  expect((JSON.parse(ownedPage.text) as { sort_scope: string }).sort_scope).toBe('page')
  await executeFantasy(h.ctx, { action: 'players', search: 'Player One' }, exec, 8_000)
  expect(h.service.players).toHaveBeenLastCalledWith(LeagueKey(league),
    { search: 'Player One', start: 0, count: 10 }, exec.signal)
  const transactions = await executeFantasy(h.ctx, { action: 'transactions', count: 1, start: 3 }, exec, 8_000)
  const transactionPage = JSON.parse(transactions.text) as { text: string }
  expect((JSON.parse(transactionPage.text) as { next_start: number | null }).next_start).toBe(4)
  expect(h.ctx.tools.get('fantasy')?.presentCall?.({ action: 'leagues' })).toMatchObject({
    card: 'generic', title: 'Fantasy', kind: 'read',
  })
})

it('rejects invalid bounds and incomplete selectors before any Yahoo request', async () => {
  const h = await setup()
  const exec = { agent: h.agent, signal: new AbortController().signal } as Parameters<typeof executeFantasy>[2]
  const bad = async (args: ToolFantasy.FantasyToolRequest, message: string) =>
    expect(executeFantasy(h.ctx, args, exec, 100)).rejects.toThrow(message)
  await expect(executeFantasy(h.ctx, { action: 'leagues' },
    { signal: exec.signal } as Parameters<typeof executeFantasy>[2], 100)).rejects.toThrow('caller Session')
  await bad({ action: 'leagues', offset: 1_000_000 }, 'offset exceeds')
  await bad({ action: 'leagues', offset: -1 }, 'offset')
  await bad({ action: 'scoreboard', week: 0 }, 'week must be positive')
  await bad({ action: 'scoreboard', week: 31 }, 'week')
  await bad({ action: 'players', availability: 'FA', start: -1 }, 'start')
  await bad({ action: 'players', availability: 'FA', count: 0 }, 'count must be positive')
  await bad({ action: 'players', search: ' ' }, 'search')
  await bad({ action: 'players', search: 'X'.repeat(101) }, 'search')
  await bad({ action: 'players', availability: 'FA', position: 'running back' }, 'position')
  await bad({ action: 'player' }, 'player key')
  await expect(setup(50)).rejects.toThrow('pageChars')
  expect(() => { ToolFantasy.apply(new Context(), { pageChars: 50 }) }).toThrow('pageChars')
  const controller = new AbortController()
  controller.abort()
  await expect(executeFantasy(h.ctx, { action: 'leagues' },
    { agent: h.agent, signal: controller.signal } as Parameters<typeof executeFantasy>[2], 100)).rejects.toThrow()
})
