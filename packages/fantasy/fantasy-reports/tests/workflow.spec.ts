import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ResearchOwner } from '@deepseek-ai/dsh-research/types'
import { resolveConfig, type Config } from '../src/config.ts'
import { weeklyReportWorkflow, type EarlierReport } from '../src/workflow.ts'
import { FANTASY_STAGE_SYSTEM_PROMPT } from '../src/prompts.ts'
import { RESEARCH_JSON_CORRECTION } from '@deepseek-ai/dsh-research-local/src/prompts.ts'
import {
  WEDNESDAY_WEEK_3, harness, playerFetch, playerPage, playerSearch, promptOf, validDraft, yahoo,
  type Harness, type Reply,
} from './support.ts'

const harnesses: Harness[] = []
afterEach(async () => { await Promise.all(harnesses.splice(0).map(item => item.dispose())) })

const base = {
  timezone: 'America/Phoenix', workspacePath: '/tmp/fantasy-reports',
  teams: [{ id: 'googies', name: 'The Googies', teamKey: '470.l.809970.t.7', channelId: '1472404859679670455',
    schedule: { full: '0 14 * * 3', thursday: '0 11 * * 4', sunday: '30 5 * * 0' } }],
  searchesPerPlayer: 2, pagesPerPlayer: 1, maxConcurrentFetches: 1,
} satisfies Config

const pass = JSON.stringify({ issues: [] })

/** Reviewer answer shape observed live: prose plus a tool call written as text. */
const REVIEWER_PSEUDO_TOOL_CALL = 'I need to verify the injury report before auditing.\n<tool_call>\n<function=session_search>\n'
  + '<parameter=query>Bijan Robinson week 3 practice</parameter>\n</function>\n</tool_call>'

/** Writer answer shape observed live: prose plus a shell command instead of the JSON draft. */
const WRITER_PROSE_ANSWER = 'Let me pull the latest practice reports first.\n\n```bash\ncurl -s https://www.espn.com/nfl/injuries\n```'

function systemOf(request: Parameters<typeof promptOf>[0]): string {
  return request.messages.filter(message => message.role === 'system')
    .flatMap(message => message.content.map(block => block.type === 'text' ? block.text : '')).join('\n')
}

/** Each case persists a 15-player run with every ledger write flushed to JSONL. */
const RUN_CASE_TIMEOUT_MS = 90_000

async function execute(replies: readonly Reply[], overrides: Partial<Config> = {}, options: Parameters<typeof harness>[1] = {},
  history: readonly EarlierReport[] = []) {
  const h = await harness(replies, options)
  harnesses.push(h)
  const config = resolveConfig(Object.assign({}, base, overrides))
  const caller = await h.ctx.agents.create({ sessionId: SessionId('fantasy-test-caller') })
  const owner: ResearchOwner = { kind: 'profile', namespace: 'beardy' }
  const view = await h.research.start({ caller: caller.agent.session, owner, query: 'Weekly report',
    workflow: weeklyReportWorkflow(h.ctx, config, { team: config.teams[0]!, settings: yahoo.settings, season: '2026', week: 3,
      mode: 'full', firedAt: WEDNESDAY_WEEK_3, history }) })
  await h.research.whenDone(view.id)
  await caller.dispose()
  const status = await h.research.status(view.id, owner)
  const handle = await h.ctx.sessionPersistence.open(SessionId(view.id), 'read')
  const events = (await handle.read()).events
  await handle.close()
  return { h, owner, status, events, id: view.id,
    report: status.phase === 'completed' ? await h.research.report(view.id, owner) : undefined }
}

describe('weekly report workflow', { timeout: RUN_CASE_TIMEOUT_MS }, () => {
  it('publishes a code-checked, reviewed report with one cited source per player and a full ledger', async () => {
    const earlier: EarlierReport = { runId: 'rp-native-earlier', week: 2, mode: 'sunday', markdown: '# Week 2 Sunday advice\nStart Hall.' }
    const { h, status, events, report } = await execute([JSON.stringify(validDraft()), pass], {}, {}, [earlier])
    expect(status).toMatchObject({ phase: 'completed', sourceCount: 15 })
    expect(status.stageSessionIds).toHaveLength(2)
    const writer = promptOf(h.adapter.requests[0]!)
    expect(writer).toContain('Yahoo context (authoritative league data)')
    expect(writer).toContain('"id":"P9","name":"Jayden Daniels"')
    expect(writer).toContain('--- Earlier week 2 sunday report ---\n# Week 2 Sunday advice')
    expect(writer).toContain(playerPage(0).text)
    const reviewer = promptOf(h.adapter.requests[1]!)
    expect(reviewer).toContain('Draft under review')
    expect(h.adapter.requests.every(request => (request.tools ?? []).length === 0)).toBe(true)
    expect(report!.markdown).toContain('# The Googies · 2026 week 3 full report')
    expect(report!.markdown).toContain('- **W/R/T** — Breece Hall')
    expect(report!.markdown).toContain('[1](<https://news.example/p1>)')
    expect(report!.markdown).not.toContain('Changes from your Yahoo lineup')
    const evidence = JSON.parse(await readEvidence(h, report!.evidenceRef)) as Record<string, unknown>
    expect(evidence).toMatchObject({ workflow: 'fantasy-weekly-report', week: 3, mode: 'full',
      history: [{ runId: 'rp-native-earlier', week: 2, mode: 'sunday' }], structuralRepairs: 0 })
    const started = events.find(event => event.type === 'research/started')
    expect(started?.data).toMatchObject({ workflow: 'fantasy-weekly-report', promptVersion: 'fantasy-weekly-v5',
      budgets: { stageTimeoutMs: 1_200_000, hardRunTimeoutMs: 14_400_000 } })
    expect(events.filter(event => event.type === 'research/search')).toHaveLength(15)
    expect(events.filter(event => event.type === 'research/finding' && event.data.accepted)).toHaveLength(15)
  })

  it('repairs a nonliteral quote structurally before the factual review and records the repair', async () => {
    const draft = validDraft()
    const broken = { ...draft, players: draft.players.map(row => row.player === 'P2'
      ? { ...row, facts: [{ ...row.facts[0]!, quote: 'was officially cleared by doctors' }] } : row) }
    const patch = JSON.stringify({ players: [draft.players[1]], lineup: [], actions: [], decisions: [], caveats: [] })
    const { h, status, report } = await execute([JSON.stringify(broken), patch, pass])
    expect(status.phase).toBe('completed')
    const repair = promptOf(h.adapter.requests[1]!)
    expect(repair).toContain('P2: fact 0 quote is not a 12 to 300 character excerpt of source 2')
    expect(repair).toContain('"player":"P2"')
    expect(report!.markdown).not.toContain('cleared by doctors')
  })

  it('keys a writer draft that named its players and a structural repair that wrote rationale, as the live stages answered', async () => {
    const draft = validDraft()
    const names = new Map(yahoo.roster.players.map((player, index) => [`P${index + 1}`, player.name]))
    const named = { ...draft, players: draft.players.map(row => ({ ...row, player: names.get(row.player)!,
      ...(row.player === 'P1' ? { facts: [{ ...row.facts[0]!, quote: 'was officially cleared by doctors' }] } : {}) })) }
    const { player: _player, reason: _reason, ...rest } = draft.players[0]!
    const patch = JSON.stringify({ players: [{ player: 'P1', ...rest, confidence: 'High', rationale: 'Lawrence keeps the QB spot.',
      sources: [1] }], lineup: [], actions: [], decisions: [], caveats: [] })
    const { h, status, report } = await execute([JSON.stringify(named), patch, pass])
    expect(status.phase).toBe('completed')
    const repair = promptOf(h.adapter.requests[1]!)
    expect(repair).toContain('- P1: fact 0 quote is not a 12 to 300 character excerpt of source 1')
    expect(repair).not.toContain('not a roster id')
    expect(repair).toContain('"player":"P1"')
    expect(repair).toContain('never a name: {"player":"P1","recommendation":"START|SIT|CONDITIONAL|HOLD","confidence":"high|medium|low","facts":[')
    expect(report!.markdown).toContain('Lawrence keeps the QB spot.')
  })

  it('applies an anchored factual finding, discards unanchored ones, and publishes after a clean second review', async () => {
    const draft = validDraft()
    const review = JSON.stringify({ issues: [
      { player: 'P7', kind: 'contradicts_source', claim: 'Row P7: the practice report supports this choice.',
        evidence: 'Breece Hall practiced fully on Wednesday', problem: 'Overstated.', fix: 'Say he practiced fully.' },
      { player: 'P7', kind: 'fabricated_or_external_fact', claim: 'Hall had 30 carries last week', evidence: '', problem: 'x', fix: 'Remove.' },
      { player: 'P1', kind: 'wording_or_precision', claim: 'Row P1: the practice report supports this choice.', evidence: '', problem: 'x', fix: 'Reword.' },
    ] })
    const { player: _player, ...row } = draft.players[6]!
    const patch = JSON.stringify({ players: [{ id: 'P7', ...row, reason: 'Hall practiced fully and keeps the flex.' }],
      lineup: [], actions: [], decisions: [], caveats: [] })
    const { h, status, report } = await execute([JSON.stringify(draft), review, patch, pass])
    expect(status.phase).toBe('completed')
    expect(promptOf(h.adapter.requests[2]!)).toContain('Reviewer findings')
    expect(promptOf(h.adapter.requests[2]!)).toContain('the roster id from the draft in "player", never a name: {"player":"P1","recommendation":"START|SIT|CONDITIONAL|HOLD"')
    expect(report!.markdown).toContain('Hall practiced fully and keeps the flex.')
    const evidence = JSON.parse(await readEvidence(h, report!.evidenceRef)) as {
      reviews: Array<{ issues: unknown[]; discarded: unknown[] }>
    }
    expect(evidence.reviews[0]!.issues).toHaveLength(1)
    expect(evidence.reviews[0]!.discarded.map(item => (item as { reason: string }).reason)).toEqual(['claim not in draft', 'wording only'])
  })

  it('withholds publication when the last review still finds a wrong team or schedule', async () => {
    const draft = validDraft()
    const wrongTeam = JSON.stringify({ issues: [{ player: 'P1', kind: 'wrong_team_or_schedule',
      claim: 'Row P1: the practice report supports this choice.', evidence: '', problem: 'Wrong opponent.', fix: 'Use the source.' }] })
    const patch = JSON.stringify({ players: [], lineup: [], actions: ['Keep the lineup.'], decisions: [], caveats: [] })
    const { status } = await execute([JSON.stringify(draft), wrongTeam, patch, wrongTeam, patch, wrongTeam], { maxReviews: 3 })
    expect(status).toMatchObject({ phase: 'failed', reason: expect.stringContaining('fantasy report withheld: the last review') as string })
  })

  it('publishes after the last review with a disclosure when the remaining findings are detail-level', async () => {
    const draft = validDraft()
    const detail = JSON.stringify({ issues: [{ player: 'P3', kind: 'contradicts_source',
      claim: 'Row P3: the practice report supports this choice.', evidence: '', problem: 'Vague.', fix: 'Be specific.' }] })
    const applied = JSON.stringify({ players: [{ ...draft.players[2]!, reason: 'Hampton practiced fully.' }] })
    const applies = await execute([JSON.stringify(draft), detail, applied], { maxReviews: 1 })
    expect(applies.status.phase).toBe('completed')
    expect(applies.report!.markdown).toContain('Hampton practiced fully.')
    expect(applies.report!.markdown).toContain('- The last round of reviewer corrections was applied without another review')
    const illegal = JSON.stringify({ lineup: [{ slot: 'QB', player: 'P9' }] })
    const keeps = await execute([JSON.stringify(draft), detail, illegal], { maxReviews: 1 })
    expect(keeps.status.phase).toBe('completed')
    expect(keeps.report!.markdown).toContain('- The last review raised detail-level notes that could not be applied')
    const unusable = await execute([JSON.stringify(draft), detail, 'no json', 'still none', 'no json again', 'none again'], { maxReviews: 1 })
    expect(unusable.report!.markdown).toContain('could not be applied')
  })

  it('withholds a draft that still fails code checks after the structural repair budget', async () => {
    const draft = validDraft()
    const illegal = { ...draft, lineup: [...draft.lineup.filter(item => item.slot !== 'QB'), { slot: 'QB', player: 'P9' }] }
    const { h, status } = await execute([JSON.stringify(illegal), 'not json', 'still not json', '{"players":[]}'], { maxStructuralRepairs: 2 })
    expect(status).toMatchObject({ phase: 'failed', reason: expect.stringContaining('the draft still fails code checks') as string })
    expect(status.reason).toContain('P9 cannot start because Jayden Daniels has Yahoo status O')
    expect(promptOf(h.adapter.requests[1]!)).toContain('- P9: starts in QB but is recommended SIT')
    expect(promptOf(h.adapter.requests[2]!)).toBe(RESEARCH_JSON_CORRECTION)
    expect(h.adapter.requests[2]!.sessionId).toBe(h.adapter.requests[1]!.sessionId)
    expect(promptOf(h.adapter.requests[3]!)).toContain('- the previous patch was unusable: Error: the response contains no JSON object')
  })

  it('rewrites an unparseable writer answer and withholds when the reviewer never returns findings JSON', async () => {
    const rewritten = await execute(['I cannot comply.', 'Still no JSON.', JSON.stringify(validDraft()), pass])
    expect(rewritten.status.phase).toBe('completed')
    expect(promptOf(rewritten.h.adapter.requests[1]!)).toBe(RESEARCH_JSON_CORRECTION)
    expect(promptOf(rewritten.h.adapter.requests[2]!)).toContain('Your previous answer was unusable')
    const silent = await execute([JSON.stringify(validDraft()), REVIEWER_PSEUDO_TOOL_CALL, 'looks fine', '{"issues":"none"}',
      'Let me verify first.\n<tool_call><function=web_search><parameter=query>Kyren Williams week 3</parameter></function></tool_call>'])
    expect(silent.status).toMatchObject({ phase: 'failed',
      reason: expect.stringContaining('the reviewer returned no usable findings JSON: Error: issues must be an array') as string })
    expect(silent.status.stageSessionIds).toHaveLength(3)
    const never = await execute(['I cannot comply.', 'Still no JSON.', 'No.', 'Nope.'], { maxStructuralRepairs: 1 })
    expect(never.status).toMatchObject({ phase: 'failed',
      reason: expect.stringContaining('the draft still fails code checks: the answer is not the required JSON draft: Error: the response contains no JSON object') as string })
  })

  it('takes the corrective JSON answer from the same stage Session after a prose or pseudo-tool-call answer', async () => {
    const { h, status } = await execute([WRITER_PROSE_ANSWER, JSON.stringify(validDraft()), REVIEWER_PSEUDO_TOOL_CALL, pass])
    expect(status.phase).toBe('completed')
    expect(status.stageSessionIds).toHaveLength(2)
    const requests = h.adapter.requests
    expect(requests).toHaveLength(4)
    expect(requests.map(request => request.sessionId)).toEqual([requests[0]!.sessionId, requests[0]!.sessionId,
      requests[2]!.sessionId, requests[2]!.sessionId])
    expect([1, 3].map(index => promptOf(requests[index]!))).toEqual([RESEARCH_JSON_CORRECTION, RESEARCH_JSON_CORRECTION])
    for (const request of requests) {
      expect(systemOf(request)).toBe(FANTASY_STAGE_SYSTEM_PROMPT)
      expect(request.tools ?? []).toEqual([])
      expect(request.temperature).toBe(0.2)
    }
  })

  it('withholds a factual repair that cannot be applied before the last review', async () => {
    const draft = validDraft()
    const detail = JSON.stringify({ issues: [{ player: null, kind: 'wrong_advice_logic',
      claim: 'Keep the current Yahoo lineup.', evidence: '', problem: 'Ignores the injury.', fix: 'Discuss Flowers.' }] })
    const { status } = await execute([JSON.stringify(draft), detail, 'nope', '{"players":[{"player":"P99"}]}', 'nope', '{"players":[{"player":"P99"}]}'])
    expect(status).toMatchObject({ phase: 'failed', reason: expect.stringContaining('the factual repair patch was unusable') as string })
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
    const draft = validDraft()
    const renumbered = (source: number): number => source === 3 ? 2 : source >= 7 ? source + 1 : source
    const noGibbs = { ...draft, decisions: draft.decisions.map(decision => ({ ...decision, sources: decision.sources.map(renumbered) })),
      players: draft.players.map(row => row.player === 'P2'
        ? { ...row, facts: [], reason: 'No current source was found; Yahoo shows no injury.' }
        : row.player === 'P3'
          ? { ...row, facts: [{ text: 'Had 20 touches.', source: 2, quote: 'Omarion Hampton had 20 touches' }] }
          : { ...row, facts: row.facts.map(fact => ({ ...fact, source: renumbered(fact.source) })) }) }
    const { h, status, events, report: done } = await execute([JSON.stringify(noGibbs), pass],
      { pagesPerPlayer: 2, searchResultsPerQuery: 10 }, { search, fetch })
    expect(status.reason).toBeUndefined()
    expect(status.phase).toBe('completed')
    const searches = events.flatMap(event => event.type === 'research/search' ? [event.data] : [])
    const sources = events.flatMap(event => event.type === 'research/source' ? [event.data] : [])
    const findings = events.flatMap(event => event.type === 'research/finding' ? [event.data] : [])
    expect(searches.find(search => search.status === 'error'))
      .toMatchObject({ query: expect.stringContaining('Jahmyr Gibbs') as string, reason: 'Error: search offline' })
    expect(sources.filter(source => source.status !== 'fetched').map(source => source.status)).toEqual(['error', 'http_error'])
    expect(findings.filter(finding => !finding.accepted).map(finding => finding.reason)).toEqual([
      'final URL is not an admissible HTTPS host', 'the page does not name Trevor Lawrence', 'the page does not name Trevor Lawrence'])
    expect(done!.markdown).toContain('No current source was admitted for Jahmyr Gibbs')
    expect(done!.sources.map(source => source.url)).toEqual(['https://news.example/p1', 'https://news.example/p3',
      'https://news.example/p3b', 'https://news.example/p4', 'https://news.example/p5', 'https://news.example/p6',
      'https://news.example/shared', ...[7, 8, 9, 10, 11, 12, 13, 14, 15].map(n => `https://news.example/p${n}`)])
    expect(done!.sources[3]!.title).toBe('https://news.example/p4')
    expect(events.filter(event => event.type === 'research/search' && event.data.query.includes('Omarion Hampton'))).toHaveLength(1)
    expect(promptOf(h.adapter.requests[0]!)).toContain('"id":7,"title":"TE room","players":["P6","P13"]')
  })

  it('withholds when no page is admitted and checks Yahoo identity and roster bounds', async () => {
    const empty = await execute([], {}, { search: async () => ({ sources: [], truncated: false }) })
    expect(empty.status).toMatchObject({ phase: 'failed', reason: expect.stringContaining('no current player source was admitted') as string })
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
  })

  it('stops collecting sources when the owner cancels the run', async () => {
    const searching = Promise.withResolvers<undefined>()
    const h = await harness([], { search: (_query, signal) => new Promise((_resolve, reject) => {
      searching.resolve(undefined)
      signal?.addEventListener('abort', () => { reject(new Error('search aborted')) }, { once: true })
    }) })
    harnesses.push(h)
    const config = resolveConfig(base)
    const caller = await h.ctx.agents.create({ sessionId: SessionId('fantasy-cancel-caller') })
    const owner: ResearchOwner = { kind: 'profile', namespace: 'beardy' }
    const view = await h.research.start({ caller: caller.agent.session, owner, query: 'Cancelled report',
      workflow: weeklyReportWorkflow(h.ctx, config, { team: config.teams[0]!, settings: yahoo.settings, season: '2026', week: 3,
        mode: 'full', firedAt: WEDNESDAY_WEEK_3, history: [] }) })
    await searching.promise
    expect(await h.research.cancel(view.id, owner)).toEqual({ requested: true })
    expect(await h.research.status(view.id, owner)).toMatchObject({ phase: 'cancelled', sourceCount: 0 })
    await caller.dispose()
  })

  it('withholds a report whose rendering exceeds the delivery bound', async () => {
    const { status } = await execute([JSON.stringify(validDraft()), pass], { maxDeliveryChars: 1000 })
    expect(status).toMatchObject({ phase: 'failed', reason: expect.stringContaining('the delivery bound is 700') as string })
  })
})

async function readEvidence(h: Harness, ref: Parameters<Harness['ctx']['attachments']['readFileStream']>[0]): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of h.ctx.attachments.readFileStream(ref)) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}
