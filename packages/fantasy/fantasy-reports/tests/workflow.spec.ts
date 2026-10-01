import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ResearchOwner } from '@deepseek-ai/dsh-research/types'
import type { FantasyRoster, TeamKey } from '@deepseek-ai/dsh-fantasy/types'
import { scoreStats } from '@deepseek-ai/dsh-fantasy'
import { RESEARCH_JSON_CORRECTION } from '@deepseek-ai/dsh-research-local/src/prompts.ts'
import { resolveConfig, type Config } from '../src/config.ts'
import { FANTASY_STAGE_SYSTEM_PROMPT } from '../src/prompts.ts'
import { CUT_NOTICE } from '../src/render.ts'
import { weeklyReportWorkflow, type EarlierReport } from '../src/workflow.ts'
import {
  WEDNESDAY_WEEK_3, harness, lockedRoster, playerFetch, playerPage, playerSearch, promptOf, replies, stageModel, stageOf, synthetic, yahoo,
  type FantasyData, type FixtureProjections, type Harness, type Reply,
} from './support.ts'

const harnesses: Harness[] = []
afterEach(async () => { await Promise.all(harnesses.splice(0).map(item => item.dispose())) })

const base = {
  timezone: 'America/Phoenix', workspacePath: '/tmp/fantasy-reports',
  teams: [{ id: 'googies', name: 'The Googies', teamKey: '470.l.809970.t.7', channelId: '1472404859679670455',
    schedule: { full: '0 14 * * 3', thursday: '0 11 * * 4', sunday: '30 5 * * 0' } }],
  searchesPerPlayer: 2, pagesPerPlayer: 1, maxConcurrentFetches: 1,
} satisfies Config

/** Each case persists a 15-player run with every ledger write flushed to JSONL. */
const RUN_CASE_TIMEOUT_MS = 90_000

function systemOf(request: Parameters<typeof promptOf>[0]): string {
  return request.messages.filter(message => message.role === 'system')
    .flatMap(message => message.content.map(block => block.type === 'text' ? block.text : '')).join('\n')
}

async function execute(script: readonly Reply[], overrides: Partial<Config> = {}, options: Parameters<typeof harness>[1] & {
  data?: Partial<FantasyData>
  history?: readonly EarlierReport[]
  projections?: Partial<Pick<FixtureProjections, 'lines' | 'failure'>>
} = {}) {
  const h = await harness(script, options)
  harnesses.push(h)
  h.fantasy.data = { ...h.fantasy.data, ...options.data }
  Object.assign(h.projections, options.projections)
  const config = resolveConfig(Object.assign({}, base, overrides))
  const caller = await h.ctx.agents.create({ sessionId: SessionId('fantasy-test-caller') })
  const owner: ResearchOwner = { kind: 'profile', namespace: 'beardy' }
  const view = await h.research.start({ caller: caller.agent.session, owner, query: 'Weekly report',
    workflow: weeklyReportWorkflow(h.ctx, config, { team: config.teams[0]!, settings: yahoo.settings, season: '2026', week: 3,
      mode: 'full', firedAt: WEDNESDAY_WEEK_3, history: options.history ?? [] }) })
  await h.research.whenDone(view.id)
  await caller.dispose()
  const status = await h.research.status(view.id, owner)
  const handle = await h.ctx.sessionPersistence.open(SessionId(view.id), 'read')
  const events = (await handle.read()).events
  await handle.close()
  const report = status.phase === 'completed' ? await h.research.report(view.id, owner) : undefined
  const evidence = report === undefined ? undefined
    : JSON.parse(await readEvidence(h, report.evidenceRef)) as Record<string, unknown>
  return { h, owner, status, events, id: view.id, report, evidence,
    stages: h.adapter.requests.map(request => stageOf(request).stage) }
}

/** The week 3 roster with Yahoo projections, and the same roster as the opponent's. */
function projected(): { roster: FantasyRoster; opponent: FantasyRoster } {
  const roster = { ...yahoo.roster, players: yahoo.roster.players.map((player, index) => index === 14 ? player
    : { ...player, projectedPoints: 20 - index }) }
  return { roster, opponent: { ...roster, team: { ...roster.team, key: '470.l.809970.t.3' as TeamKey },
    players: [...roster.players, synthetic('Unslotted', ['WR'], { projectedPoints: 50 })] } }
}

describe('weekly report pipeline', { timeout: RUN_CASE_TIMEOUT_MS }, () => {
  it('runs code facts, batched player calls, close calls, waivers, the reason check, and the summary, then publishes', async () => {
    const earlier: EarlierReport = { runId: 'rp-native-earlier', week: 2, mode: 'sunday', markdown: '# Week 2 Sunday advice\nStart Hall.' }
    const { h, status, events, report, evidence, stages } = await execute(replies(), {},
      { data: { freeAgents: { WR: yahoo.available } }, history: [earlier] })
    expect(status).toMatchObject({ phase: 'completed', sourceCount: 15 })
    expect(stages).toEqual(['player calls', 'player calls', 'player calls', 'close calls', 'waiver picks', 'reason check', 'summary'])
    expect(status.stageSessionIds).toHaveLength(7)
    expect(h.fantasy.freeAgentReads).toEqual(['WR'])
    const first = promptOf(h.adapter.requests[0]!)
    expect(first).toMatch(/^Stage: player calls\. This is the midweek full report\./u)
    expect(first).toContain('Return ONLY this JSON object with exactly these keys (P1, P2, P3, P4, P5)')
    expect(first).toContain(`"excerpts":[{"source":1,"text":"${playerPage(0).text.replace('Week 3 notes. ', '')}"}]`)
    expect(first).toContain('"id":"P5","name":"Zay Flowers","nflTeam":"Bal","positions":["WR"],"status":"Q","injury":"Hamstring",'
      + '"bye":13,"projection":null,"yahooSlot":"WR","slotLocked":false,"codeCall":"START","codeSlot":"WR"')
    expect(first).toContain('"matchup":{"week":3,"team":"The Googies","opponent":"Team 5","projected":{"team":116.14,"opponent":94.56}}')
    expect(promptOf(h.adapter.requests[3]!)).toContain('"flagged":"uncertain starter"')
    expect(promptOf(h.adapter.requests[4]!)).toContain('"positions":[{"position":"WR","reasons":["Zay Flowers is Q"],"projectionGap":null}]')
    expect(promptOf(h.adapter.requests[6]!)).toContain('--- Earlier week 2 sunday report ---\\n# Week 2 Sunday advice')
    expect(h.adapter.requests.every(request => (request.tools ?? []).length === 0)).toBe(true)
    expect(h.adapter.requests.every(request => systemOf(request) === FANTASY_STAGE_SYSTEM_PROMPT)).toBe(true)
    const markdown = report!.markdown
    expect(markdown).toContain('# The Googies · 2026 week 3 full report')
    expect(markdown).toContain('## Summary\nThe Googies keep their Yahoo lineup this week.')
    expect(markdown).toContain('- **W/R/T** Breece Hall · NYJ · proj n/a\n')
    expect(markdown).toContain('**Zay Flowers or Jordan Addison** (WR)\nZay Flowers stays ahead of Jordan Addison this week.')
    expect(markdown).toContain('## Waiver ideas\n- **Olamide Zaccheaus** · WR · Atl — The best available fill-in.')
    expect(markdown).toContain('**Trevor Lawrence — START** · QB · Jax · bye 7\nTrevor Lawrence keeps the code call. [1](<https://news.example/p1>)')
    expect(markdown).not.toContain('Changes from your Yahoo lineup')
    expect(markdown).not.toContain('code reason')
    expect(evidence).toMatchObject({ workflow: 'fantasy-weekly-report', promptVersion: 'fantasy-weekly-v6', week: 3, mode: 'full',
      history: [{ runId: 'rp-native-earlier', week: 2, mode: 'sunday' }], waivers: ['W1'], comparisons: ['C1'], caveats: [] })
    expect((evidence!.stages as unknown[]).every(stage => (stage as { usable: boolean }).usable)).toBe(true)
    const started = events.find(event => event.type === 'research/started')
    expect(started?.data).toMatchObject({ workflow: 'fantasy-weekly-report', promptVersion: 'fantasy-weekly-v6',
      budgets: { stageTimeoutMs: 1_200_000, hardRunTimeoutMs: 14_400_000 } })
    expect(events.filter(event => event.type === 'research/search')).toHaveLength(15)
    expect(events.filter(event => event.type === 'research/finding' && event.data.accepted)).toHaveLength(15)
  })

  it('retries invalid or missing players once in a request for just those ids, then keeps the code default', async () => {
    let calls = 0
    const model = stageModel({ 'player calls': (data) => {
      calls++
      const sheets = data.players!
      if (calls === 1) {
        return { P1: { call: 'START', reason: 'Starts.', sources: [] }, P2: { call: 'BENCH', reason: 'Bench.' },
          P4: { call: 'START', reason: 'Starts.', sources: [99] }, P5: { call: 'START', reason: 'Starts.' } }
      }
      if (calls === 2) return { P2: { call: 'START', reason: 'Lead back.', sources: [2] }, P3: 'START' }
      return Object.fromEntries(sheets.map(sheet => [sheet.id, { call: sheet.codeCall, reason: 'Code call.' }]))
    } })
    const { h, status, report, stages } = await execute(replies(model), { playersPerStage: 8, checkReasons: false, maxCloseCalls: 0 })
    expect(status.phase).toBe('completed')
    expect(stages).toEqual(['player calls', 'player calls', 'player calls', 'summary'])
    const retry = stageOf(h.adapter.requests[1]!).data
    expect(retry.players!.map(sheet => sheet.id)).toEqual(['P2', 'P3', 'P4', 'P6', 'P7', 'P8'])
    expect(report!.markdown).toContain('**Jahmyr Gibbs — START** · RB · Det · bye 6\nLead back. [2](<https://news.example/p2>)')
    expect(report!.markdown).toContain('- Code defaults stand for Omarion Hampton, Parker Washington, Tyler Warren, Breece Hall, '
      + 'Jordan Addison: no valid model call after one retry (P3: not an object; P4: missing; P6: missing; P7: missing; P8: missing).')
    expect(report!.markdown).toContain('**Omarion Hampton — START** · RB · LAC · bye 7 · code reason\nStarts at RB; no projection.')
  })

  it('takes the corrective JSON answer after a pseudo tool call and keeps a stage error from stopping the report', async () => {
    const pseudo = 'I need to verify the injury report first.\n<tool_call>\n<function=session_search>\n</function>\n</tool_call>'
    const corrected = stageModel({ 'player calls': (data, request) => promptOf(request) === RESEARCH_JSON_CORRECTION
      ? Object.fromEntries(data.players!
        .map(sheet => [sheet.id, { call: sheet.codeCall, reason: 'Corrected answer.', sources: sheet.excerpts.map(item => item.source) }]))
      : pseudo })
    const { h, status, report } = await execute([corrected, corrected], { playersPerStage: 15 },
      { data: { freeAgents: { WR: [synthetic('Free Wide', ['WR'], { rank: 3, percentOwned: 20 })] } } })
    expect(status.phase).toBe('completed')
    expect(promptOf(h.adapter.requests[1]!)).toBe(RESEARCH_JSON_CORRECTION)
    expect(report!.markdown).toContain('**Trevor Lawrence — START** · QB · Jax · bye 7\nCorrected answer. [1](<https://news.example/p1>)')
    expect(report!.markdown).toContain('- No comparison of Zay Flowers and Jordan Addison: the close-call answer was unusable.')
    expect(report!.markdown).toContain('- No waiver ideas: the waiver answer was unusable.')
    expect(report!.markdown).toContain('- The reason check did not run: its answer was unusable.')
    expect(report!.markdown).toContain('- The summary is written by code: the summary answer was unusable.')
    expect(report!.markdown).toContain('## Summary\nThe Googies faces Team 5; Yahoo projects 116.1 to 94.6. '
      + 'The suggested lineup keeps every current Yahoo starter.')
  })

  it('applies legal model swaps, rejects locked and unavailable moves, and drops unusable stage items', async () => {
    const model = stageModel({
      'player calls': data => Object.fromEntries(data.players!
        .map(sheet => [sheet.id, { call: { P4: 'SIT', P5: 'SIT', P8: 'START', P9: 'START' }[sheet.id] ?? sheet.codeCall,
          reason: `Call for ${sheet.id}.`, sources: sheet.excerpts.map(item => item.source) }])),
      'waiver picks': () => ({ picks: [{ id: 'W7', reason: 'Unknown.' }, { id: 'W1', reason: 'https://x.example' }] }),
      'reason check': () => ({ unsupported: ['P8', 'P99'] }),
    })
    const { report, evidence } = await execute(replies(model), { playersPerStage: 15 },
      { data: { roster: lockedRoster([3]), freeAgents: { WR: yahoo.available } } })
    const markdown = report!.markdown
    expect(markdown).toContain('Changes from your Yahoo lineup: start Jordan Addison, bench Zay Flowers.')
    expect(markdown).toContain('- **WR** Parker Washington · Jax · proj n/a · locked')
    expect(markdown).toContain('**Zay Flowers — SIT** · WR · Bal · bye 13\nCall for P5. [5](<https://news.example/p5>)')
    expect(markdown).toContain('**Jordan Addison — START** · WR · Min · bye 6 · code reason\nStarts at WR; no projection.')
    expect(markdown).toContain('- Code kept the lineup call for Parker Washington: the model call was rejected because '
      + 'Yahoo has locked his slot because his game has started.')
    expect(markdown).toContain('- Code kept the lineup call for Jayden Daniels: the model call was rejected because '
      + 'he cannot start while Yahoo status O.')
    expect(markdown).toContain('- The reason check found no support for the model reasons of Jordan Addison; plain code reasons replace them.')
    expect(markdown).not.toContain('## Waiver ideas')
    expect(evidence!.waivers).toEqual([])
  })

  it('drops unusable close calls, waiver answers, reason checks, and summaries without withholding', async () => {
    const model = stageModel({ 'close calls': () => 'Flowers or Addison? Hard to say.', 'waiver picks': () => ({ picks: 'W1' }),
      'reason check': () => ({ unsupported: 'P1' }), summary: () => ({ summary: 'Short.' }) })
    const { report, evidence } = await execute(replies(model), {}, { data: { freeAgents: { WR: yahoo.available } } })
    const markdown = report!.markdown
    expect(markdown).toContain('- No comparison of Zay Flowers and Jordan Addison: the close-call answer was unusable.')
    expect(markdown).toContain('- No waiver ideas: the waiver answer was unusable.')
    expect(markdown).toContain('- The reason check did not run: its answer was unusable.')
    expect(markdown).toContain('- The summary is written by code: the summary answer was unusable.')
    expect((evidence!.stages as Array<{ stage: string; usable: boolean; detail?: string }>).filter(stage => !stage.usable)).toEqual([
      { stage: 'close calls', usable: false, detail: 'Error: the response contains no JSON object' },
      { stage: 'waivers', usable: false, detail: 'Error: picks must be an array' },
      { stage: 'reason check', usable: false, detail: 'Error: unsupported must be an array' },
      { stage: 'summary', usable: false, detail: 'Error: summary must be 40 to 900 characters without URLs' },
    ])
    const partial = await execute(replies(stageModel({ 'close calls': () => ({ C1: { text: 'Cites an unshown page.', sources: [1] } }) })),
      { checkReasons: false })
    expect(partial.report!.markdown).toContain('- No comparison of Zay Flowers and Jordan Addison: the close-call answer was unusable.')
  })

  it('withholds the report only when no model stage answers usably', async () => {
    const prose = await execute(replies('I cannot answer in JSON.'), { checkReasons: false })
    expect(prose.status).toMatchObject({ phase: 'failed',
      reason: expect.stringContaining('fantasy report withheld: no model stage returned a usable answer (invalid: P1 (the response contains no JSON object)') as string })
    const silent = await execute([])
    expect(silent.status).toMatchObject({ phase: 'failed',
      reason: expect.stringContaining('no model stage returned a usable answer (stage error: Error: research stage had no settled assistant response)') as string })
  })

  it('compares projected slots with the opponent and lists Yahoo read failures as caveats', async () => {
    const { roster, opponent } = projected()
    const compared = await execute(replies(), { checkReasons: false },
      { data: { roster, opponent, freeAgents: { QB: [], RB: yahoo.freeAgentBacks } } })
    expect(compared.h.fantasy.freeAgentReads).toEqual(['QB', 'RB', 'WR', 'TE', 'K', 'DEF'])
    expect(compared.report!.markdown).toContain('By slot (yours vs theirs): QB 20.0–20.0 · RB 37.0–37.0 · WR 33.0–33.0 · TE 15.0–15.0 · '
      + 'W/R/T 14.0–14.0 · K 7.0–7.0 · DEF 0.0–0.0')
    const failed = await execute(replies(), { checkReasons: false, maxCloseCalls: 0 },
      { data: { roster, freeAgentFailure: new Error('Yahoo rate limited') } })
    expect(failed.report!.markdown).toContain('- Yahoo free agents at QB could not be read (Error: Yahoo rate limited).')
    expect(failed.report!.markdown).toContain('- The opponent\'s Yahoo roster could not be read, so the slot comparison is missing '
      + '(Error: opponent roster unavailable).')
    const bare = synthetic('Bare Rookie', ['WR'])
    const thin = { ...yahoo.roster, players: [...yahoo.roster.players.slice(0, 14).map(player => player.name === 'Zay Flowers'
      ? { ...player, status: 'O' } : player), bare] }
    const unmatched = await execute(replies(stageModel({ summary: () => ({ summary: 'Short.' }) })), { waiverPositions: 0 },
      { data: { matchups: [], roster: thin } })
    expect(unmatched.h.fantasy.freeAgentReads).toEqual([])
    expect(promptOf(unmatched.h.adapter.requests[2]!)).toContain('{"id":"P15","name":"Bare Rookie","nflTeam":null,"positions":["WR"],'
      + '"status":null,"injury":null,"bye":null,"projection":null,"yahooSlot":null,"slotLocked":false,"codeCall":"SIT","codeSlot":"BN"')
    const markdown = unmatched.report!.markdown
    expect(markdown).not.toContain('**Matchup:**')
    expect(markdown).toContain('## Summary\nThe Googies has no Yahoo matchup this week. Suggested lineup changes: start Jordan Addison, '
      + 'bench Zay Flowers.')
    expect(markdown).toContain('- **DEF** — empty: no eligible player can play')
    expect(markdown).toContain('- No eligible player can fill DEF this week.')
  })

  it('fills only missing projections from projection stat lines under league scoring, one read per player list', async () => {
    const { roster, opponent } = projected()
    const lawrence = { 4: 250, 5: 2, 6: 1, 9: 10 }
    const back = yahoo.freeAgentBacks[0]!
    const { h, report, evidence } = await execute(replies(), { checkReasons: false }, {
      data: { roster: { ...roster, players: roster.players.map((player, index) => index === 0
        ? { ...player, projectedPoints: undefined } : player) }, opponent, freeAgents: { RB: yahoo.freeAgentBacks } },
      projections: { lines: { 'Trevor Lawrence': lawrence, 'Jahmyr Gibbs': { 9: 500 }, [back.name]: { 9: 300 } } },
    })
    const expected = scoreStats(lawrence, yahoo.settings.scoring)
    expect(expected).toBeGreaterThan(0)
    expect(h.projections.reads.map(read => [read.season, read.week, read.names.length])).toEqual([
      [2026, 3, 15], [2026, 3, 0], [2026, 3, 10], [2026, 3, 0], [2026, 3, 0], [2026, 3, 0], [2026, 3, 0], [2026, 3, 16]])
    expect(report!.markdown).toContain(`- **QB** Trevor Lawrence · Jax · proj ${expected.toFixed(1)}`)
    expect(report!.markdown).toContain('- **RB** Jahmyr Gibbs · Det · proj 19.0')
    expect(evidence!.projectedPoints)
      .toEqual({ [roster.players[0]!.key]: expected, [back.key]: scoreStats({ 9: 300 }, yahoo.settings.scoring) })
    expect((evidence!.yahoo as { freeAgents: Record<string, Array<{ projectedPoints?: number }>> }).freeAgents.RB![0]!.projectedPoints)
      .toBe(back.projectedPoints)
  })

  it('keeps Yahoo projections and adds a caveat when a projection read fails', async () => {
    const { roster, opponent } = projected()
    const { status, report } = await execute(replies(), { checkReasons: false, maxCloseCalls: 0 },
      { data: { roster, opponent, freeAgents: { RB: yahoo.freeAgentBacks } }, projections: { failure: new Error('projections offline') } })
    expect(status.phase).toBe('completed')
    expect(report!.markdown).toContain('- Projections for the roster could not be read (Error: projections offline).')
    expect(report!.markdown).toContain('- Projections for free agents at RB could not be read (Error: projections offline).')
    expect(report!.markdown).toContain('- Projections for the opponent\'s roster could not be read (Error: projections offline).')
    expect(report!.markdown).toContain('- **QB** Trevor Lawrence · Jax · proj 20.0')
  })

  it('admits only pages that name the player and records search, fetch, and admission outcomes', async () => {
    const search = async (query: string) => {
      const found = await playerSearch(query)
      if (query.includes('Trevor Lawrence')) {
        return { sources: [{ url: 'http://plain.example/qb' }, { url: 'https://www.reddit.com/r/nfl' },
          { url: 'https://down.example/qb' }, { url: 'https://missing.example/qb' }, { url: 'https://moved.example/qb' },
          { url: 'https://shell.example/qb', title: 'Shell' }, ...found.sources], truncated: false }
      }
      if (query.includes('Jahmyr Gibbs')) throw new Error('search offline')
      if (query.includes('Omarion Hampton')) {
        return { sources: [...found.sources, { url: 'https://news.example/p3b', title: 'b' }, { url: 'https://news.example/p3c', title: 'c' }], truncated: false }
      }
      if (query.includes('Parker Washington')) return { sources: [{ url: found.sources[0]!.url }], truncated: false }
      if (query.includes('Tyler Warren')) return { sources: [...found.sources, { url: 'https://news.example/shared', title: 'TE room' }], truncated: false }
      if (query.includes('Isaiah Likely')) return { sources: [{ url: 'https://news.example/shared', title: 'TE room' }, ...found.sources], truncated: false }
      return found
    }
    const fetch = async (url: string) => {
      if (url === 'https://down.example/qb') throw new Error('connection reset')
      if (url === 'https://missing.example/qb') return { url, statusCode: 404, body: { kind: 'text' as const, content: '' }, truncated: false }
      if (url === 'https://moved.example/qb') return { url: 'https://www.youtube.com/watch', statusCode: 200, body: { kind: 'text' as const, content: 'x' }, truncated: false }
      if (url === 'https://shell.example/qb') return { url, statusCode: 200, body: { kind: 'text' as const, content: 'News | Scores | Fantasy' }, truncated: false }
      if (url.startsWith('https://news.example/p3')) return { url, statusCode: 200, body: { kind: 'text' as const, content: 'Omarion Hampton had 20 touches.' }, truncated: false }
      if (url.endsWith('/shared')) {
        return { url, statusCode: 200, body: { kind: 'text' as const, content: 'Tyler Warren and Isaiah Likely split tight end snaps.' }, truncated: false }
      }
      return playerFetch(url)
    }
    const { h, status, events, report: done } = await execute(replies(),
      { pagesPerPlayer: 2, searchResultsPerQuery: 10, playersPerStage: 15 }, { search, fetch })
    expect(status.reason).toBeUndefined()
    expect(status.phase).toBe('completed')
    const searches = events.flatMap(event => event.type === 'research/search' ? [event.data] : [])
    const sources = events.flatMap(event => event.type === 'research/source' ? [event.data] : [])
    const findings = events.flatMap(event => event.type === 'research/finding' ? [event.data] : [])
    expect(searches.find(item => item.status === 'error'))
      .toMatchObject({ query: expect.stringContaining('Jahmyr Gibbs') as string, reason: 'Error: search offline' })
    expect(sources.filter(source => source.status !== 'fetched').map(source => source.status)).toEqual(['error', 'http_error'])
    expect(findings.filter(finding => !finding.accepted).map(finding => finding.reason)).toEqual([
      'final URL is not an admissible HTTPS host', 'the page does not name Trevor Lawrence', 'the page does not name Trevor Lawrence'])
    expect(done!.markdown).toContain('- No current news page was admitted for Jahmyr Gibbs; their calls rest on Yahoo data.')
    expect(done!.markdown).toContain('- News pages that failed to load: 2.')
    expect(done!.sources.map(source => source.url)).toEqual(['https://news.example/p1', 'https://news.example/p3',
      'https://news.example/p3b', 'https://news.example/p4', 'https://news.example/p5', 'https://news.example/p6',
      'https://news.example/shared', ...[7, 8, 9, 10, 11, 12, 13, 14, 15].map(n => `https://news.example/p${n}`)])
    expect(done!.sources[3]!.title).toBe('https://news.example/p4')
    expect(events.filter(event => event.type === 'research/search' && event.data.query.includes('Omarion Hampton'))).toHaveLength(1)
    expect(promptOf(h.adapter.requests[0]!)).toContain('"id":"P13","name":"Isaiah Likely"')
    expect(promptOf(h.adapter.requests[0]!))
      .toContain('"excerpts":[{"source":7,"text":"Tyler Warren and Isaiah Likely split tight end snaps."},{"source":14,')
  })

  it('withholds on Yahoo identity or roster bound failures and stops when the owner cancels', async () => {
    const h = await harness([])
    harnesses.push(h)
    const config = resolveConfig({ ...base, maxPlayers: 10 })
    const caller = await h.ctx.agents.create({ sessionId: SessionId('fantasy-bounds-caller') })
    const owner: ResearchOwner = { kind: 'profile', namespace: 'beardy' }
    const start = async (week: number) => {
      const view = await h.research.start({ caller: caller.agent.session, owner, query: `Bounds ${week}`,
        workflow: weeklyReportWorkflow(h.ctx, config, { team: config.teams[0]!, settings: yahoo.settings, season: '2026', week,
          mode: 'sunday', firedAt: WEDNESDAY_WEEK_3, history: [] }) })
      await h.research.whenDone(view.id)
      return h.research.status(view.id, owner)
    }
    expect(await start(4)).toMatchObject({ reason: expect.stringContaining('different league, team, or week') as string })
    expect(await start(3)).toMatchObject({ reason: expect.stringContaining('the Yahoo roster has 15 players; reports cover 1 to 10') as string })
    await caller.dispose()
    const searching = Promise.withResolvers<undefined>()
    const hung = await harness([], { search: (_query, signal) => new Promise((_resolve, reject) => {
      searching.resolve(undefined)
      signal?.addEventListener('abort', () => { reject(new Error('search aborted')) }, { once: true })
    }) })
    harnesses.push(hung)
    const other = await hung.ctx.agents.create({ sessionId: SessionId('fantasy-cancel-caller') })
    const view = await hung.research.start({ caller: other.agent.session, owner, query: 'Cancelled report',
      workflow: weeklyReportWorkflow(hung.ctx, resolveConfig(base), { team: config.teams[0]!, settings: yahoo.settings, season: '2026',
        week: 3, mode: 'full', firedAt: WEDNESDAY_WEEK_3, history: [] }) })
    await searching.promise
    expect(await hung.research.cancel(view.id, owner)).toEqual({ requested: true })
    expect(await hung.research.status(view.id, owner)).toMatchObject({ phase: 'cancelled', sourceCount: 0 })
    await other.dispose()
  })

  it('cuts a report longer than the delivery bound instead of withholding it', async () => {
    const { status, report } = await execute(replies(), { maxDeliveryChars: 1000, checkReasons: false })
    expect(status.phase).toBe('completed')
    expect(report!.markdown.length).toBeLessThanOrEqual(700)
    expect(report!.markdown.endsWith(`${CUT_NOTICE}\n`)).toBe(true)
  })
})

async function readEvidence(h: Harness, ref: Parameters<Harness['ctx']['attachments']['readFileStream']>[0]): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of h.ctx.attachments.readFileStream(ref)) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}
