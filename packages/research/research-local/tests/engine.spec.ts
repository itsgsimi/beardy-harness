import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import WebRuntime from '@deepseek-ai/dsh-web'
import type { WebFetchResult, WebSearchResult } from '@deepseek-ai/dsh-web'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { ReasoningEffortId, type RequestMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import LocalResearchService, { type Config } from '../src/index.ts'
import { boundEvidence, boundReport, checkCitationUrls, mapLimit, parseFinding, parseQueries } from '../src/engine.ts'
import { datePreamble, finalPrompt, queryPrompt, RESEARCH_JSON_CORRECTION, RESEARCH_STAGE_SYSTEM_PROMPT } from '../src/prompts.ts'
import { StageAdmission } from '../src/stage.ts'

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function harness(
  responses: Array<string | { hang: true } | StreamChunk[]>,
  search: (query: string, signal?: AbortSignal) => Promise<WebSearchResult>,
  fetch: (url: string, signal?: AbortSignal) => Promise<WebFetchResult>,
  settings: Partial<Config> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'research-engine-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(LocalAttachmentStore, { dshHome: root })
  await ctx.plugin(WebRuntime, { searchProvider: 'test', fetchProvider: 'test' })
  ctx.web.registerSearchProvider({ id: 'test', available: () => true, search: (request, signal) => search(request.query, signal) })
  ctx.web.registerFetchProvider({ id: 'test', available: () => true, fetch: (request, signal) => fetch(request.url, signal) })
  const adapter = new MockAdapter(responses.map(response => typeof response === 'string' ? textResponse(response)
    : Array.isArray(response) ? response : 'hang'))
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(AgentLoop, { agents: [] })
  const providerFiber = await ctx.plugin(LocalResearchService, { provider: 'mock', model: 'test-model',
    maxRounds: 1, minRounds: 1, maxEmptyRounds: 1, firstRoundQueries: 2,
    maxPagesPerRound: 2, maxTotalPages: 2, ...settings })
  const caller = await ctx.agents.create({ sessionId: SessionId('research-engine-caller') })
  const owner = { kind: 'session' as const, sessionId: caller.agent.session.id }
  return { ctx, root, adapter, caller, owner, providerFiber, local: ctx.research as LocalResearchService }
}

function systemText(messages: readonly RequestMessage[]): string {
  return messages.filter(message => message.role === 'system')
    .flatMap(message => message.content.map(block => block.type === 'text' ? block.text : '')).join('\n')
}

function result(urls: string[]): WebSearchResult {
  return { sources: urls.map(url => ({ url, title: url })), truncated: false }
}

function page(url: string, content = '<h1>Evidence</h1><p>Useful fact</p>'): WebFetchResult {
  return { url, statusCode: 200, body: { kind: 'html', content }, truncated: false }
}

it('deduplicates queries and URLs, logs each exact stage request, and commits cited sources', async () => {
  const urls = ['https://example.com/a', 'https://example.com/b']
  const h = await harness([
    '{"sub_questions":["a"],"key_topics":["a"],"success_criteria":"a"}',
    '["Alpha", "alpha", "Beta"]',
    '{"rational":"Relevant","evidence":"Useful fact A","summary":"Fact A"}',
    '{"rational":"Relevant","evidence":"Useful fact B","summary":"Fact B"}',
    'Draft with [A](https://example.com/a) and [B](https://example.com/b).',
    'YES — covered.',
    '# Report\n[A](https://example.com/a) [B](https://example.com/b) [unsupported](https://other.example/x)',
  ], async () => result([...urls, urls[0]!, 'ftp://example.com/file', 'bad url', 'https://example.com/c']),
  async url => page(url, `<h1>Evidence</h1><p>${'Useful fact '.repeat(200)}</p>`),
  { maxPageChars: 1000, maxTotalPages: 3 })
  h.ctx.tools.register(defineContentToolFixture({
    name: 'forbidden_stage_tool', description: 'Must not enter a research stage', parameters: {},
    execute: async () => [{ type: 'text', text: 'escaped' }],
  }))
  const requests: Array<{ id: SessionId; through: number; messages: RequestMessage[] }> = []
  h.ctx.on('llm/stream', (request, next) => {
    const session = h.ctx.sessions.get(request.sessionId!)!
    const cut = session.snapshotEvents()
    const rebuilt = Session.create(session.id, cut, session.header)
    expect(request.messages).toEqual(rebuilt.deriveMessages())
    expect(request.tools ?? []).toEqual([])
    requests.push({ id: session.id, through: cut.length, messages: request.messages })
    return next()
  })
  const view = await h.local.start({ caller: h.caller.agent.session, owner: h.owner, query: 'Explain evidence' })
  await h.local.whenDone(view.id)
  const completed = await h.local.status(view.id, h.owner)
  expect(completed.reason).toBeUndefined()
  expect(completed.phase).toBe('completed')
  const report = await h.local.report(view.id, h.owner)
  expect(report.sources).toHaveLength(2)
  expect(report.sources.every(source => source.truncated && source.statusCode === 200)).toBe(true)
  expect(report.markdown).toContain('unverified citation omitted')
  expect(report.markdown).toContain('Citation limitations')
  const boundedManifest = boundEvidence({ promptVersion: 'v1', question: 'q', category: 'general',
    stopReason: 'round limit', stopped: false, sources: [...report.sources],
    accepted: [{ url: urls[0]!, summary: 'first' }, { url: urls[1]!, summary: 'second' }] }, 200)
  const manifest = JSON.parse(boundedManifest.text) as {
    truncated: boolean
    accepted: unknown[]
    sources: unknown[]
  }
  expect(boundedManifest.truncated).toBe(true)
  expect(manifest).toMatchObject({ truncated: true, accepted: [], sources: [] })
  const persisted = await h.ctx.sessionPersistence.open(SessionId(view.id), 'read')
  const events = (await persisted.read()).events
  await persisted.close()
  expect(events.filter(event => event.type === 'research/search')).toHaveLength(2)
  expect(events.filter(event => event.type === 'research/source')).toHaveLength(2)
  expect(events.filter(event => event.type === 'research/finding')).toHaveLength(2)
  expect(requests).toHaveLength(7)
  expect(new Set(requests.map(request => request.id)).size).toBe(7)
  for (const { id, through, messages } of requests) {
    const stage = await h.ctx.sessionPersistence.open(SessionId(id), 'read')
    const log = await stage.read()
    const header = stage.header
    expect(header.parentSession).toBe(view.id)
    await stage.close()
    expect(log.events.some(event => event.type === 'request/header')).toBe(true)
    expect(log.events.some(event => event.type === 'turn/end')).toBe(true)
    expect(Session.create(id, log.events.slice(0, through), header).deriveMessages()).toEqual(messages)
  }
  await h.caller.dispose()
})

it('retains the caller workspace on the run and each persisted stage child', async () => {
  const h = await harness(['plan', '[]'], async () => result([]), async url => page(url))
  const caller = await h.ctx.agents.create({ sessionId: SessionId('research-workspace-caller'), meta: { cwd: h.root } })
  const owner = { kind: 'session' as const, sessionId: caller.agent.session.id }
  const view = await h.local.start({ caller: caller.agent.session, owner, query: 'Workspace' })
  await h.local.whenDone(view.id)
  const run = await h.ctx.sessionPersistence.open(SessionId(view.id), 'read')
  expect(run.header.cwd).toBe(h.root)
  await run.close()
  const settled = await h.local.status(view.id, owner)
  expect(settled.stageSessionIds).toHaveLength(2)
  for (const id of settled.stageSessionIds) {
    const stage = await h.ctx.sessionPersistence.open(id, 'read')
    expect(stage.header).toMatchObject({ cwd: h.root, parentSession: view.id })
    await stage.close()
  }
  await caller.dispose()
  await h.caller.dispose()
})

it('parses bounded queries and extraction objects, preserving only supported citation URLs', () => {
  expect(parseQueries('```json\n[" A ", "a", "B"]\n```', 2)).toEqual(['A', 'B'])
  expect(parseQueries('answer: ["one", "two"] trailing', 3)).toEqual(['one', 'two'])
  expect(parseQueries('answer: ["one",] trailing', 3)).toEqual([])
  expect(parseQueries('["complete", "unfinished', 3)).toEqual(['complete'])
  expect(parseQueries('[bad]', 2)).toEqual([])
  expect(parseQueries('["\\uZZZZ"', 2)).toEqual([])
  expect(parseQueries('garbage', 2)).toEqual([])
  expect(parseQueries('{}', 2)).toEqual([])
  expect(parseQueries('[1, false, "good"]', 2)).toEqual(['good'])
  expect(parseFinding('{"rational":"r","evidence":"e","summary":"Useful"}')).toEqual({ rational: 'r', evidence: 'e', summary: 'Useful' })
  expect(parseFinding('{bad')).toBeUndefined()
  expect(parseFinding('null')).toBeUndefined()
  expect(parseFinding('"wrong"')).toBeUndefined()
  expect(parseFinding('[]')).toBeUndefined()
  expect(parseFinding('{"summary":"missing"}')).toBeUndefined()
  expect(parseFinding('{"rational":"r","evidence":" ","summary":"x"}')).toBeUndefined()
  expect(parseFinding('{"rational":"r","evidence":"e","summary":" "}')).toBeUndefined()
  expect(parseFinding('{"rational":"r","evidence":"e","summary":"cookie banner"}')).toBeUndefined()
  const checked = checkCitationUrls('[A](https://example.com/#part) [B](https://bad.example/) [local](./file)', new Set(['https://example.com/']))
  expect(checked.unsupported).toEqual(['https://bad.example/'])
  expect(checked.markdown).toContain('Citation limitations')
  expect(checkCitationUrls('[bad](https://[invalid)', new Set()).unsupported).toEqual(['https://[invalid'])
  expect(checkCitationUrls('[ok](https://example.com/)', new Set(['https://example.com/']))).toEqual({ markdown: '[ok](https://example.com/)', unsupported: [] })
  const references = checkCitationUrls('See https://bad.example/a, [note]: https://bad.example/b. <https://example.com/>',
    new Set(['https://example.com/']))
  expect(references.unsupported).toEqual(['https://bad.example/a', 'https://bad.example/b'])
  expect(references.markdown).toContain('[unverified citation omitted],')
  expect(references.markdown).toContain('<https://example.com/>')
  expect(datePreamble(new Date('2026-09-27T12:00:00Z'))).toContain('2026')
  expect(queryPrompt({ question: 'q', plan: 'p', draft: 'd', round: 2, count: 3, date: 'today' })).toContain('Target gaps')
  expect(finalPrompt({ question: 'q', category: 'factcheck', draft: 'd', urls: [] })).toContain('verdict')
  expect(boundReport('é', 1)).toEqual({ text: '', truncated: true })
  expect(boundReport('plain', 10)).toEqual({ text: 'plain', truncated: false })
  expect(() => boundEvidence({ promptVersion: 'v1', question: 'question', category: 'general',
    stopReason: 'limit', stopped: false, sources: [], accepted: [] }, 1)).toThrow('evidence exceeds')
})

it('uses the final fetched URL as a source title when search omitted one', async () => {
  const h = await harness(['plan', '["query"]', '{"rational":"r","evidence":"e","summary":"finding"}',
    'draft', 'YES', '# Final'], async () => ({ sources: [{ url: 'https://example.com/page' }], truncated: false }),
  async url => page(url), { maxEvidenceBytes: 200 })
  const view = await h.local.start({ caller: h.caller.agent.session, owner: h.owner, query: 'Title' })
  await h.local.whenDone(view.id)
  expect((await h.local.report(view.id, h.owner)).sources[0]?.title).toBe('https://example.com/page')
  const handle = await h.ctx.sessionPersistence.open(SessionId(view.id), 'read')
  const log = await handle.read()
  await handle.close()
  expect(log.events.find(event => event.type === 'research/finished')).toMatchObject({ data: { quality: 'partial' } })
  await h.caller.dispose()
})

it('falls back to the question after an empty first query response and ignores a repeated later query', async () => {
  const h = await harness(['plan', '[]', '["Question"]'], async () => result([]), async url => page(url),
    { maxRounds: 2, minRounds: 2, maxEmptyRounds: 2 })
  const view = await h.local.start({ caller: h.caller.agent.session, owner: h.owner, query: 'Question' })
  await h.local.whenDone(view.id)
  const handle = await h.ctx.sessionPersistence.open(SessionId(view.id), 'read')
  const log = await handle.read()
  await handle.close()
  expect(log.events.filter(event => event.type === 'research/search')).toHaveLength(1)
  expect(log.events.flatMap(event => event.type === 'research/checkpoint' && event.data.queries !== undefined
    ? [event.data.queries] : [])).toEqual([['Question'], []])
  expect((await h.local.status(view.id, h.owner)).phase).toBe('failed')
  await h.caller.dispose()
})

it('stops at the soft deadline after planning and commits an unavailable result', async () => {
  const h = await harness(['plan'], async () => result([]), async url => page(url), { softRunTimeoutMs: 1 })
  h.ctx.on('llm/stream', async function* (_request, next) {
    await new Promise(resolve => setTimeout(resolve, 20))
    yield* next()
  })
  const view = await h.local.start({ caller: h.caller.agent.session, owner: h.owner, query: 'Slow plan' })
  await h.local.whenDone(view.id)
  expect(await h.local.status(view.id, h.owner)).toMatchObject({ phase: 'failed', reason: 'source unavailable' })
  await h.caller.dispose()
})

it('waits for a model admission slot and aborts a queued stage without acquiring it', async () => {
  const gate = new StageAdmission(1)
  const first = await gate.acquire(new AbortController().signal)
  const queued = new AbortController()
  const waiting = gate.acquire(queued.signal)
  queued.abort(new Error('cancelled admission'))
  await expect(waiting).rejects.toThrow('cancelled admission')
  first()
  const next = await gate.acquire(new AbortController().signal)
  const another = new AbortController()
  const waitingAgain = gate.acquire(another.signal)
  another.abort('queue closed')
  await expect(waitingAgain).rejects.toThrow('queue closed')
  next()
  const preaborted = new AbortController()
  preaborted.abort(new Error('already cancelled'))
  await expect(gate.acquire(preaborted.signal)).rejects.toThrow('already cancelled')
})

it('joins dispatched parallel operations before reporting the first failure', async () => {
  const settled: number[] = []
  await expect(mapLimit([1, 2], 2, new AbortController().signal, async (item) => {
    if (item === 1) throw new Error('first failed')
    await new Promise(resolve => setTimeout(resolve, 20))
    settled.push(item)
    return item
  })).rejects.toThrow('first failed')
  expect(settled).toEqual([2])
})

it('records search outages and ends after the configured empty-round limit', async () => {
  const h = await harness(['plan', '["outage"]'], async () => { throw new Error('search offline') }, async url => page(url))
  const view = await h.local.start({ caller: h.caller.agent.session, owner: h.owner, query: 'Outage' })
  await h.local.whenDone(view.id)
  expect(await h.local.status(view.id, h.owner)).toMatchObject({ phase: 'failed', reason: 'source unavailable' })
  const handle = await h.ctx.sessionPersistence.open(SessionId(view.id), 'read')
  const log = await handle.read()
  await handle.close()
  expect(log.events.find(event => event.type === 'research/search')).toMatchObject({ data: { status: 'error', urls: [] } })
  await h.caller.dispose()
})

it('rejects malformed extraction and ends without fabricating a source finding', async () => {
  const h = await harness(['plan', '["query"]', '{"summary":"missing fields"}'],
    async () => result(['https://example.com/page']), async url => page(url))
  const view = await h.local.start({ caller: h.caller.agent.session, owner: h.owner, query: 'Malformed' })
  await h.local.whenDone(view.id)
  expect(await h.local.status(view.id, h.owner)).toMatchObject({ phase: 'failed', reason: 'source unavailable' })
  const handle = await h.ctx.sessionPersistence.open(SessionId(view.id), 'read')
  const log = await handle.read()
  await handle.close()
  expect(log.events.find(event => event.type === 'research/finding')).toMatchObject({ data: { accepted: false } })
  await h.caller.dispose()
})

it('continues after a NO stop decision and finishes after a later YES', async () => {
  const h = await harness([
    'plan', '["first"]',
    '{"rational":"r","evidence":"first evidence","summary":"first finding"}',
    'first draft', 'NO — one gap remains',
    '["second"]',
    '{"rational":"r","evidence":"second evidence","summary":"second finding"}',
    'combined draft', 'YES — complete', '# Final [one](https://example.com/first)',
  ], async query => result([`https://example.com/${query}`]), async url => page(url),
  { maxRounds: 2, maxEmptyRounds: 2, maxPagesPerRound: 1, maxTotalPages: 2 })
  const view = await h.local.start({ caller: h.caller.agent.session, owner: h.owner, query: 'Two rounds', category: 'comparison' })
  await h.local.whenDone(view.id)
  expect(await h.local.status(view.id, h.owner)).toMatchObject({ phase: 'completed', round: 2, sourceCount: 2 })
  expect((await h.local.report(view.id, h.owner)).markdown).toContain('Final')
  await h.caller.dispose()
})

it('records non-2xx and failed fetch attempts before source-unavailable termination', async () => {
  const h = await harness(['plan', '["one", "two"]'], async () => result([
    'https://example.com/404', 'https://example.com/error',
  ]), async (url) => {
    if (url.endsWith('error')) throw new Error('fetch offline')
    return { ...page(url), statusCode: 404 }
  })
  const view = await h.local.start({ caller: h.caller.agent.session, owner: h.owner, query: 'No pages' })
  await h.local.whenDone(view.id)
  const handle = await h.ctx.sessionPersistence.open(SessionId(view.id), 'read')
  const log = await handle.read()
  await handle.close()
  expect(log.events.filter(event => event.type === 'research/source').map(event => event.data.status).sort())
    .toEqual(['error', 'http_error'])
  expect((await h.local.status(view.id, h.owner)).phase).toBe('failed')
  await h.caller.dispose()
})

it('cancels an active model stream and keeps the first terminal result', async () => {
  const h = await harness([{ hang: true }], async () => result([]), async url => page(url))
  const entered = Promise.withResolvers<boolean>()
  h.ctx.on('llm/stream', (_request, next) => { entered.resolve(true); return next() })
  const view = await h.local.start({ caller: h.caller.agent.session, owner: h.owner, query: 'Cancel stream' })
  await entered.promise
  expect(await h.local.cancel(view.id, h.owner)).toEqual({ requested: true })
  expect((await h.local.status(view.id, h.owner)).phase).toBe('cancelled')
  expect(await h.local.cancel(view.id, h.owner)).toEqual({ requested: false })
  await h.caller.dispose()
})

it('retains the last committed draft and source list when cancellation interrupts a stop stage', async () => {
  const h = await harness([
    'plan', '["query"]', '{"rational":"r","evidence":"e","summary":"finding"}',
    '# Partial [source](https://example.com/page)', { hang: true },
  ], async () => result(['https://example.com/page']), async url => page(url))
  const stopEntered = Promise.withResolvers<boolean>()
  let calls = 0
  h.ctx.on('llm/stream', (_request, next) => { if (++calls === 5) stopEntered.resolve(true); return next() })
  const view = await h.local.start({ caller: h.caller.agent.session, owner: h.owner, query: 'Partial cancel' })
  await stopEntered.promise
  expect(await h.local.cancel(view.id, h.owner)).toEqual({ requested: true })
  expect(await h.local.report(view.id, h.owner)).toMatchObject({ complete: false,
    markdown: '# Partial [source](https://example.com/page)' })
  await h.caller.dispose()
})

it('does not publish a partial report when its source manifest cannot fit', async () => {
  const h = await harness([
    'plan', '["query"]', '{"rational":"r","evidence":"e","summary":"finding"}',
    '# Draft', { hang: true },
  ], async () => result(['https://example.com/page']), async url => page(url), { maxEvidenceBytes: 1 })
  const stopEntered = Promise.withResolvers<boolean>()
  let calls = 0
  h.ctx.on('llm/stream', (_request, next) => { if (++calls === 5) stopEntered.resolve(true); return next() })
  const view = await h.local.start({ caller: h.caller.agent.session, owner: h.owner, query: 'Tiny manifest' })
  await stopEntered.promise
  await h.local.cancel(view.id, h.owner)
  expect((await h.local.status(view.id, h.owner)).reportAvailable).toBe(false)
  await expect(h.local.report(view.id, h.owner)).rejects.toThrow('unavailable')
  await h.caller.dispose()
})

it.each(['search', 'fetch'] as const)('propagates cancellation into active %s', async (kind) => {
  const entered = Promise.withResolvers<boolean>()
  let aborted = false
  const wait = (signal?: AbortSignal): Promise<never> => {
    entered.resolve(true)
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) }, { once: true })
    })
  }
  const h = await harness(['plan', '["query"]'],
    async (_query, signal) => kind === 'search' ? wait(signal) : result(['https://example.com/page']),
    async (url, signal) => kind === 'fetch' ? wait(signal) : page(url))
  const view = await h.local.start({ caller: h.caller.agent.session, owner: h.owner, query: `Cancel ${kind}` })
  await entered.promise
  expect(await h.local.cancel(view.id, h.owner)).toEqual({ requested: true })
  expect(aborted).toBe(true)
  expect((await h.local.status(view.id, h.owner)).phase).toBe('cancelled')
  await h.caller.dispose()
})

it('counts queued admission in the hard timeout and permits only one active model stream', async () => {
  const h = await harness([{ hang: true }, { hang: true }], async () => result([]), async url => page(url),
    { hardRunTimeoutMs: 350, softRunTimeoutMs: 350, stageTimeoutMs: 350 })
  let active = 0
  let maximum = 0
  const firstCall = Promise.withResolvers<boolean>()
  h.ctx.on('llm/stream', async function* (_request, next) {
    active++
    maximum = Math.max(maximum, active)
    firstCall.resolve(true)
    try { yield* next() } finally { active-- }
  })
  const first = await h.local.start({ caller: h.caller.agent.session, owner: h.owner, query: 'First' })
  await firstCall.promise
  const second = await h.local.start({ caller: h.caller.agent.session, owner: h.owner, query: 'Second' })
  await Promise.all([h.local.whenDone(first.id), h.local.whenDone(second.id)])
  expect(maximum).toBe(1)
  expect((await h.local.status(first.id, h.owner)).phase).toBe('budget_exhausted')
  expect((await h.local.status(second.id, h.owner)).phase).toBe('budget_exhausted')
  await h.caller.dispose()
})

it('rejects unsupported categories, reasoning routes and context windows before committing a run', async () => {
  const h = await harness([], async () => result([]), async url => page(url), { reasoningEffort: 'high' })
  const request = { caller: h.caller.agent.session, owner: h.owner, query: 'Admission' }
  await expect(h.local.start({ ...request, category: 'general', workflow: { name: 'weekly', promptVersion: 'v1',
    run: async () => ({ markdown: '', evidence: '', quality: 'partial' }) } })).rejects.toThrow('take no category')
  await expect(h.local.start(request)).rejects.toThrow('reasoningEffort')
  h.adapter.resolveModel = async (provider, model) => ({ provider, id: model, name: model,
    reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }] }, context: { contextWindow: 8192 } })
  await expect(h.local.start(request)).rejects.toThrow('stage maxTokens')
  expect(await h.local.list({ owner: h.owner, limit: 10 })).toEqual([])
  const plan = await harness([], async () => result([]), async url => page(url),
    { planMaxTokens: 3000, queryMaxTokens: 1000, extractMaxTokens: 1000, reportMaxTokens: 1000 })
  plan.adapter.resolveModel = async (provider, model) => ({ provider, id: model, name: model,
    context: { contextWindow: 2500 } })
  await expect(plan.local.start({ caller: plan.caller.agent.session, owner: plan.owner, query: 'Admission' }))
    .rejects.toThrow('stage maxTokens')
  await plan.caller.dispose()
  await h.caller.dispose()
})

it('bounds an individual stage input against the resolved model context', async () => {
  const h = await harness([], async () => result([]), async url => page(url), {
    planMaxTokens: 1000, queryMaxTokens: 1000, extractMaxTokens: 1000, reportMaxTokens: 1000,
  })
  h.adapter.resolveModel = async (provider, model) => ({ provider, id: model, name: model,
    context: { contextWindow: 1001 } })
  const view = await h.local.start({ caller: h.caller.agent.session, owner: h.owner, query: 'Context' })
  await h.local.whenDone(view.id)
  expect(await h.local.status(view.id, h.owner)).toMatchObject({ phase: 'failed', reason: 'Error: research stage input exceeds the model context window' })
  await h.caller.dispose()
})

it('returns the same live and completed run for an exact start key', async () => {
  const h = await harness([{ hang: true }], async () => result([]), async url => page(url))
  const entered = Promise.withResolvers<boolean>()
  h.ctx.on('llm/stream', (_request, next) => { entered.resolve(true); return next() })
  const request = { caller: h.caller.agent.session, owner: h.owner, query: 'Repeated', requestKey: 'exact' }
  const first = await h.local.start(request)
  await entered.promise
  expect((await h.local.start(request)).id).toBe(first.id)
  await h.local.cancel(first.id, h.owner)
  expect(await h.local.start(request)).toMatchObject({ id: first.id, phase: 'cancelled' })
  await h.caller.dispose()
})

it('drops a stage tool contributed inside the scoped Agent from the request and denies its execution', async () => {
  const h = await harness(['plan', toolCallResponse('call', 'scoped_stage_tool', {})], async () => result([]), async url => page(url))
  let executed = 0
  h.ctx.on('agent/created', ({ agent }) => {
    if (!agent.session.header.parentSession?.startsWith('rp-native-')) return
    agent.ctx.tools.register(defineContentToolFixture({
      name: 'scoped_stage_tool', description: 'Untrusted scoped tool', parameters: {},
      execute: async () => { executed++; return [{ type: 'text', text: 'escaped' }] },
    }))
  })
  const view = await h.local.start({ caller: h.caller.agent.session, owner: h.owner, query: 'Tool check' })
  await h.local.whenDone(view.id)
  expect((await h.local.status(view.id, h.owner)).phase).toBe('failed')
  expect(executed).toBe(0)
  expect(h.adapter.requests).toHaveLength(2)
  expect(h.adapter.requests.every(request => (request.tools ?? []).length === 0)).toBe(true)
  await h.caller.dispose()
})

it('refuses a second model call after a tool-call response in one stage', async () => {
  const h = await harness([toolCallResponse('call', 'forbidden_stage_tool', {}), 'unexpected'],
    async () => result([]), async url => page(url))
  let executed = 0
  h.ctx.tools.register(defineContentToolFixture({
    name: 'forbidden_stage_tool', description: 'Must never run', parameters: {},
    execute: async () => { executed++; return [{ type: 'text', text: 'escaped' }] },
  }))
  const view = await h.local.start({ caller: h.caller.agent.session, owner: h.owner, query: 'Tool call' })
  await h.local.whenDone(view.id)
  expect((await h.local.status(view.id, h.owner)).phase).toBe('failed')
  expect(executed).toBe(0)
  expect(h.adapter.requests).toHaveLength(1)
  await h.caller.dispose()
})

it('uses a supported reasoning effort in each stage request', async () => {
  const h = await harness(['plan', '["query"]'], async () => result([]), async url => page(url), { reasoningEffort: 'high' })
  h.adapter.resolveModel = async (provider, model) => ({ provider, id: model, name: model,
    reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }] } })
  const view = await h.local.start({ caller: h.caller.agent.session, owner: h.owner, query: 'Reasoning' })
  await h.local.whenDone(view.id)
  expect(h.adapter.requests.map(request => request.reasoningEffort)).toEqual([
    ReasoningEffortId('high'), ReasoningEffortId('high'),
  ])
  await h.caller.dispose()
})

it('fails a stage when its Session cannot be flushed', async () => {
  const h = await harness(['plan'], async () => result([]), async url => page(url))
  const flush = h.ctx.sessions.flush.bind(h.ctx.sessions)
  vi.spyOn(h.ctx.sessions, 'flush').mockImplementation(session => session.header.parentSession?.startsWith('rp-native-')
    ? Promise.resolve(false) : flush(session))
  const view = await h.local.start({ caller: h.caller.agent.session, owner: h.owner, query: 'Stage flush' })
  await h.local.whenDone(view.id)
  expect(await h.local.status(view.id, h.owner)).toMatchObject({ phase: 'failed', reason: 'Error: research stage has no durability provider' })
  await h.caller.dispose()
})

it('interrupts a live worker when its provider is disposed', async () => {
  const h = await harness([{ hang: true }], async () => result([]), async url => page(url))
  const entered = Promise.withResolvers<boolean>()
  h.ctx.on('llm/stream', (_request, next) => { entered.resolve(true); return next() })
  const view = await h.local.start({ caller: h.caller.agent.session, owner: h.owner, query: 'Shutdown' })
  await entered.promise
  await h.providerFiber.dispose()
  expect((await h.local.status(view.id, h.owner)).phase).toBe('interrupted')
  await h.caller.dispose()
})

it('surfaces a failed terminal flush to a waiter without an unhandled background rejection', async () => {
  const h = await harness(['plan', '["query"]'], async () => result([]), async url => page(url))
  const flush = h.ctx.sessions.flush.bind(h.ctx.sessions)
  vi.spyOn(h.ctx.sessions, 'flush').mockImplementation(session =>
    session.snapshotEvents().at(-1)?.type === 'research/finished' ? Promise.resolve(false) : flush(session))
  const view = await h.local.start({ caller: h.caller.agent.session, owner: h.owner, query: 'Terminal flush' })
  await expect(h.local.whenDone(view.id)).rejects.toThrow('research run has no durability provider')
  await h.caller.dispose()
})

it('refuses to run a retried start whose durable run lost its live Agent', async () => {
  const h = await harness([], async () => result([]), async url => page(url))
  const request = { caller: h.caller.agent.session, owner: h.owner, query: 'Orphan', requestKey: 'orphan-key' }
  const off = h.ctx.on('session/flush', (session) => {
    if (session.id === h.caller.agent.session.id) throw new Error('caller disk failed')
  })
  await expect(h.local.start(request)).rejects.toThrow('caller disk failed')
  off()
  await expect(h.local.start(request)).rejects.toThrow('research run has no live Agent')
  expect(await h.local.list({ owner: h.owner, limit: 10 })).toMatchObject([{ query: 'Orphan', phase: 'running' }])
  expect(h.adapter.requests).toHaveLength(0)
  await h.caller.dispose()
})

it('answers from the dedicated stage system prompt at the configured temperature with no tools', async () => {
  const h = await harness(['plan', '[]'], async () => result([]), async url => page(url), { stageTemperature: 0.7 })
  h.ctx.tools.register(defineContentToolFixture({
    name: 'leaked_stage_tool', description: 'Must not reach a research stage', parameters: {},
    execute: async () => [{ type: 'text', text: 'escaped' }],
  }))
  vi.spyOn(ToolRuntime.prototype, 'restrict').mockReturnValue(() => {})
  const view = await h.local.start({ caller: h.caller.agent.session, owner: h.owner, query: 'Stage prompt' })
  await h.local.whenDone(view.id)
  expect(h.adapter.requests).toHaveLength(2)
  for (const request of h.adapter.requests) {
    expect(systemText(request.messages)).toBe(RESEARCH_STAGE_SYSTEM_PROMPT)
    expect(request.tools ?? []).toEqual([])
    expect(request.temperature).toBe(0.7)
  }
  const failed = await h.local.status(view.id, h.owner)
  const stage = await h.ctx.sessionPersistence.open(failed.stageSessionIds[0]!, 'read')
  const events = (await stage.read()).events
  await stage.close()
  expect(events.find(event => event.type === 'request/header')?.data).toMatchObject({ header: { config: { temperature: 0.7 } } })
  await h.caller.dispose()
})

it('counts only its own model request while another stage streams concurrently', async () => {
  const h = await harness([{ hang: true }, { hang: true }], async () => result([]), async url => page(url),
    { maxConcurrentModelCalls: 2 })
  let active = 0
  const both = Promise.withResolvers<boolean>()
  h.ctx.on('llm/stream', async function* (_request, next) {
    if (++active === 2) both.resolve(true)
    try { yield* next() } finally { active-- }
  })
  const first = await h.local.start({ caller: h.caller.agent.session, owner: h.owner, query: 'First' })
  const second = await h.local.start({ caller: h.caller.agent.session, owner: h.owner, query: 'Second' })
  await both.promise
  expect(await Promise.all([h.local.cancel(first.id, h.owner), h.local.cancel(second.id, h.owner)]))
    .toEqual([{ requested: true }, { requested: true }])
  for (const id of [first.id, second.id]) {
    expect(await h.local.status(id, h.owner)).toMatchObject({ phase: 'cancelled', reason: 'cancelled by owner' })
  }
  expect(h.adapter.requests).toHaveLength(2)
  await h.caller.dispose()
})

it('runs a consumer workflow through logged stages, ledger writes, and a completed report', async () => {
  const h = await harness(['{"verdict":"ok"}'], async () => result([]), async url => page(url), { stageTimeoutMs: 1 })
  h.ctx.web.assertAvailable = () => { throw new Error('a workflow owns its own web use') }
  const seen: string[] = []
  let runId: string | undefined
  const view = await h.local.start({ caller: h.caller.agent.session, owner: h.owner, query: 'Weekly workflow',
    workflow: { name: 'weekly-report', promptVersion: 'weekly-v1', budgets: { stageTimeoutMs: 60000, hardRunTimeoutMs: 120000 },
      async run(run) {
        runId = run.id
        await run.search({ round: 1, query: 'player news', status: 'ok', urls: ['https://example.com/news'] })
        const source = await run.fetched({ round: 1, requestedUrl: 'https://example.com/news', url: 'https://example.com/final',
          title: 'News', statusCode: 200, retrievedAt: 5, text: 'Exact page text', truncated: false })
        await run.failed({ round: 2, requestedUrl: 'https://example.com/down', retrievedAt: 6, status: 'error', reason: 'offline' })
        await run.finding({ round: 2, url: source.url, accepted: true })
        seen.push(await run.stage('Write JSON', 100))
        await expect(run.stage('Too large', 0)).rejects.toThrow(/maxTokens must be positive/)
        return { markdown: `# Weekly\n${source.contentSha256}`, evidence: '{"ok":true}', quality: 'verified_urls' }
      } } })
  await h.local.whenDone(view.id)
  expect(seen).toEqual(['{"verdict":"ok"}'])
  expect(runId).toBe(view.id)
  const settled = await h.local.status(view.id, h.owner)
  expect(settled).toMatchObject({ phase: 'completed', round: 2, sourceCount: 1 })
  expect(settled.stageSessionIds).toHaveLength(1)
  const report = await h.local.report(view.id, h.owner)
  expect(report.markdown).toContain('# Weekly')
  expect(report.sources[0]).toMatchObject({ url: 'https://example.com/final', requestedUrl: 'https://example.com/news', retrievedAt: 5 })
  const handle = await h.ctx.sessionPersistence.open(SessionId(view.id), 'read')
  const log = await handle.read()
  await handle.close()
  expect(log.events.find(event => event.type === 'research/started')?.data).toMatchObject({
    workflow: 'weekly-report', promptVersion: 'weekly-v1', budgets: { stageTimeoutMs: 60000, hardRunTimeoutMs: 120000 } })
  expect(log.events.filter(event => event.type === 'research/source').map(event => event.data.status)).toEqual(['fetched', 'error'])
  expect(log.events.find(event => event.type === 'research/finished')?.data).toMatchObject({ phase: 'completed', quality: 'verified_urls' })
  await h.caller.dispose()
})

it('fails a workflow run with its rejection reason and bounds stage input by the context window', async () => {
  const h = await harness([], async () => result([]), async url => page(url))
  const failed = await h.local.start({ caller: h.caller.agent.session, owner: h.owner, query: 'Blocked workflow',
    workflow: { name: 'weekly-report', promptVersion: 'weekly-v1', async run() { throw new Error('publication blocked: lineup') } } })
  await h.local.whenDone(failed.id)
  expect(await h.local.status(failed.id, h.owner)).toMatchObject({ phase: 'failed', reason: 'Error: publication blocked: lineup' })
  h.adapter.resolveModel = async (provider, model) => ({ provider, id: model, name: model, context: { contextWindow: 9000 } })
  const bounded = await h.local.start({ caller: h.caller.agent.session, owner: h.owner, query: 'Bounded workflow',
    workflow: { name: 'weekly-report', promptVersion: 'weekly-v1', async run(run) {
      await run.stage('x'.repeat(3000), 8500)
      return { markdown: '', evidence: '', quality: 'partial' }
    } } })
  await h.local.whenDone(bounded.id)
  expect(await h.local.status(bounded.id, h.owner)).toMatchObject({ phase: 'failed', reason: expect.stringContaining('context window') as string })
  await h.caller.dispose()
})

it('sends one corrective turn in the same stage Session when a JSON stage answers with prose or a pseudo tool call', async () => {
  const pseudoToolCall = 'Let me check the latest news first.\n<tool_call><function=session_search><parameter=query>Bijan Robinson injury</parameter></function></tool_call>'
  const issues = '{"issues":[]}'
  const h = await harness([pseudoToolCall, issues, issues, 'The draft looks fine to me.', 'Still no JSON here.',
    'I will run `curl https://example.com` first.', ''], async () => result([]), async url => page(url))
  const isReview = (text: string): boolean => {
    try {
      return Array.isArray((JSON.parse(text) as { issues?: unknown }).issues)
    } catch {
      return false
    }
  }
  const seen: string[] = []
  const view = await h.local.start({ caller: h.caller.agent.session, owner: h.owner, query: 'Corrective workflow',
    workflow: { name: 'weekly-report', promptVersion: 'weekly-v1', stageSystemPrompt: 'You are a test stage. Answer with JSON.',
      async run(run) {
        seen.push(await run.stage('Review A', 100, { expectJson: isReview }))
        seen.push(await run.stage('Review B', 100, { expectJson: isReview, temperature: 1 }))
        seen.push(await run.stage('Review C', 100, { expectJson: isReview }))
        seen.push(await run.stage('Review D', 100, { expectJson: isReview }))
        await expect(run.stage('Review E', 100, { temperature: 2.5 })).rejects.toThrow(/stage temperature/)
        return { markdown: '# Done', evidence: '{}', quality: 'partial' }
      } } })
  await h.local.whenDone(view.id)
  expect(await h.local.status(view.id, h.owner)).toMatchObject({ phase: 'completed' })
  expect(seen).toEqual([issues, issues, 'The draft looks fine to me.', 'I will run `curl https://example.com` first.'])
  expect((await h.local.status(view.id, h.owner)).stageSessionIds).toHaveLength(4)
  const requests = h.adapter.requests
  expect(requests).toHaveLength(7)
  expect(requests.map(request => systemText(request.messages))).toEqual(Array(7).fill('You are a test stage. Answer with JSON.'))
  expect(requests.map(request => request.temperature)).toEqual([0.2, 0.2, 1, 0.2, 0.2, 0.2, 0.2])
  expect(requests[0]!.sessionId).toBe(requests[1]!.sessionId)
  const corrective = JSON.stringify(requests[1]!.messages)
  expect(corrective).toContain('session_search')
  expect(corrective).toContain(JSON.stringify(RESEARCH_JSON_CORRECTION).slice(1, -1))
  expect(JSON.stringify(requests[2]!.messages)).not.toContain('requested JSON')
  await h.caller.dispose()
})

it('lets a whole-host shutdown dispose a live stage Agent before the run aborts it', async () => {
  const h = await harness([{ hang: true }], async () => result([]), async url => page(url))
  const entered = Promise.withResolvers<boolean>()
  h.ctx.on('llm/stream', (_request, next) => { entered.resolve(true); return next() })
  await h.local.start({ caller: h.caller.agent.session, owner: h.owner, query: 'Host shutdown' })
  await entered.promise
  contexts.splice(contexts.indexOf(h.ctx), 1)
  await h.ctx.fiber.dispose()
})
