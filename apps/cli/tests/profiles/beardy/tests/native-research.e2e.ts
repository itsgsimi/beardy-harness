/** Native research through the shipped Beardy CLI, with local and opt-in remote providers. */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clearedProxyEnv } from '@deepseek-ai/dsh-http-proxy'
import { execa } from 'execa'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { ResearchDriverEvidence } from './fixtures/research-driver.ts'

const repoRoot = fileURLToPath(new URL('../../../../../../', import.meta.url))
const bin = join(repoRoot, 'apps/cli/src/bin.ts')
const tsxHook = import.meta.resolve('tsx/esm')
const driver = fileURLToPath(new URL('./fixtures/research-driver.ts', import.meta.url))
const forbidden = new Set(['192.168.1.182', '127.0.0.1:8000', '127.0.0.1:8080', '127.0.0.1:7000'])
const live = {
  enabled: process.env.DSH_RESEARCH_E2E === '1',
  baseURL: process.env.DSH_RESEARCH_LLM_BASE_URL,
  provider: process.env.DSH_RESEARCH_LLM_PROVIDER,
  model: process.env.DSH_RESEARCH_LLM_MODEL,
  searxng: process.env.DSH_RESEARCH_SEARXNG_URL,
}
const runLive = live.enabled && Boolean(live.baseURL && live.provider && live.model && live.searxng)

interface FixtureServer {
  origin: string
  maxActiveModels: number
  modelRequests: number
  searches: number
  pages: number
  close(): Promise<void>
}

interface ModelProxy {
  baseURL: string
  maxActiveModels: number
  modelRequests: number
  close(): Promise<void>
}

interface LaunchOptions {
  provider: string
  model: string
  baseURL: string
  searxng: string
  runId?: string
  fixtureOrigin?: string
}

/** One ephemeral search, page, and OpenAI-compatible model server. */
async function fixtureServer(): Promise<FixtureServer> {
  let origin = ''
  let activeModels = 0
  let maxActiveModels = 0
  let modelRequests = 0
  let searches = 0
  let pages = 0
  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = new URL(request.url ?? '/', origin).pathname
    if (path === '/search') {
      searches++
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ results: [
        { url: `${origin}/page/a`, title: 'Fixture source A', content: 'Current evidence A' },
        { url: `${origin}/page/b`, title: 'Fixture source B', content: 'Current evidence B' },
      ] }))
      return
    }
    if (path.startsWith('/page/')) {
      pages++
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(`<h1>Source ${path}</h1><p>Current fixture evidence from ${path}.</p>`)
      return
    }
    if (path !== '/v1/chat/completions') { response.writeHead(404); response.end(); return }
    let body = ''
    for await (const chunk of request) body += String(chunk)
    const payload = JSON.parse(body) as { messages?: unknown[] }
    const prompt = JSON.stringify(payload.messages ?? [])
    modelRequests++
    activeModels++
    maxActiveModels = Math.max(maxActiveModels, activeModels)
    response.on('close', () => { activeModels-- })
    let answer: string
    if (prompt.includes('research strategist')) answer = '{"sub_questions":["evidence"],"key_topics":["sources"],"success_criteria":"cite both sources"}'
    else if (prompt.includes('planning web searches')) answer = '["current fixture research evidence"]'
    else if (prompt.includes('Extract relevant information')) answer = '{"rational":"Relevant","evidence":"Current fixture evidence","summary":"The source supplies current evidence."}'
    else if (prompt.includes('Update the evolving research report')) answer = `Draft with [A](${origin}/page/a) and [B](${origin}/page/b).`
    else if (prompt.includes('Decide whether this report answers')) answer = 'YES — both sources covered.'
    else if (prompt.includes('Write a detailed, useful research report')) answer = `# Current evidence\n\n[A](${origin}/page/a) and [B](${origin}/page/b).`
    else answer = 'Fixture model received an unexpected stage prompt.'
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const event = (value: unknown) => { response.write(`data: ${JSON.stringify(value)}\n\n`) }
    event({ choices: [{ delta: { role: 'assistant', content: '' }, index: 0, finish_reason: null }] })
    // Keep the stream active long enough for both runs to contend for the single route slot.
    const timer = setTimeout(() => {
      if (response.destroyed) return
      event({ choices: [{ delta: { content: answer }, index: 0, finish_reason: null }] })
      event({ choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 10 } })
      response.end('data: [DONE]\n\n')
    }, 80)
    response.on('close', () => { clearTimeout(timer) })
  }
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500)
      response.end(String(error))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server has no port')
  origin = `http://127.0.0.1:${address.port}`
  return { origin, get maxActiveModels() { return maxActiveModels }, get modelRequests() { return modelRequests },
    get searches() { return searches }, get pages() { return pages },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => { resolve() })) } }
}

/** Count actual provider dispatches while forwarding an explicitly opted-in live route. */
async function modelProxy(targetBaseURL: string): Promise<ModelProxy> {
  const target = new URL(`${targetBaseURL.replace(/\/$/u, '')}/chat/completions`)
  let activeModels = 0
  let maxActiveModels = 0
  let modelRequests = 0
  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') {
      response.writeHead(404)
      response.end()
      return
    }
    const abort = new AbortController()
    activeModels++
    modelRequests++
    maxActiveModels = Math.max(maxActiveModels, activeModels)
    response.on('close', () => { activeModels--; abort.abort() })
    try {
      let body = ''
      for await (const chunk of request) body += String(chunk)
      const upstream = await fetch(target, { method: 'POST', signal: abort.signal, body,
        headers: { 'content-type': 'application/json',
          ...(typeof request.headers.authorization === 'string' ? { authorization: request.headers.authorization } : {}) } })
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'text/event-stream' })
      if (upstream.body !== null) {
        for await (const chunk of upstream.body) {
          if (response.destroyed) break
          response.write(chunk)
        }
      }
      response.end()
    } catch (error: unknown) {
      if (abort.signal.aborted) return
      response.writeHead(502, { 'content-type': 'text/plain' })
      response.end(String(error))
    }
  }
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(502)
      response.end(String(error))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('model proxy has no port')
  return { baseURL: `http://127.0.0.1:${address.port}/v1`,
    get maxActiveModels() { return maxActiveModels }, get modelRequests() { return modelRequests },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => { resolve() })) } }
}

function assertAllowedEndpoint(value: string): void {
  const url = new URL(value)
  if (forbidden.has(url.host) || forbidden.has(url.hostname)) {
    throw new Error(`research e2e endpoint ${url.host} is excluded from this run`)
  }
}

function patch(phase: 'run' | 'reopen', options: LaunchOptions): unknown[] {
  return [
    { id: 'llm-deepseek', disabled: true },
    { id: 'session-title-llm', disabled: true },
    { id: 'tool-discord', disabled: true },
    { id: 'discord-gateway', disabled: true },
    { id: 'cron', disabled: true },
    { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: false, trustedHosts: [] } },
    { id: 'llm-pi-ai', config: { providers: { [options.provider]: {
      api: 'openai-completions', baseURL: options.baseURL, apiKeyEnv: 'DSH_RESEARCH_TEST_KEY',
      maxConcurrentRequests: 1, queueTimeoutMs: 300_000,
      models: [{ id: options.model, contextWindow: 131_072, maxTokens: 8192 }],
    } } } },
    { id: 'agent-default-model', config: { provider: options.provider, model: options.model } },
    { id: 'tool-odysseus-research', disabled: true },
    { id: 'research-local', disabled: false, config: {
      provider: options.provider, model: options.model, ownerScope: 'session',
      maxRounds: 1, minRounds: 1, maxEmptyRounds: 1, firstRoundQueries: 1,
      searchResultsPerQuery: 2, maxPagesPerRound: 2, maxTotalPages: 2,
      maxConcurrentModelCalls: 2, maxConcurrentSearches: 1, maxConcurrentFetches: 2,
      softRunTimeoutMs: 600_000, hardRunTimeoutMs: 1_800_000, stageTimeoutMs: 300_000,
      reportPageChars: 16000,
    } },
    { id: 'tool-research', disabled: false },
    { id: 'web', config: { searchProvider: 'searxng', fetchProvider: options.fixtureOrigin === undefined ? 'http' : 'research-fixture' } },
    { id: 'web-search-searxng', config: { baseURL: options.searxng } },
    { insert: [{ id: 'research-e2e-driver', name: driver, config: {
      phase, provider: options.provider, model: options.model, ...(options.runId === undefined ? {} : { runId: options.runId }),
      ...(options.fixtureOrigin === undefined ? {} : { fixtureOrigin: options.fixtureOrigin }),
      query: options.fixtureOrigin === undefined
        ? 'As of today, compare the latest stable Node.js release from nodejs.org with the latest TypeScript release from typescriptlang.org. Fetch and cite at least two independent source pages.'
        : 'What do two current independent sources say about this topic?',
    } }] },
  ]
}

async function launch(root: string, phase: 'run' | 'reopen', options: LaunchOptions): Promise<ResearchDriverEvidence> {
  const patchPath = join(root, `${phase}.patch.yml`)
  await writeFile(patchPath, `${JSON.stringify(patch(phase, options))}\n`)
  // No shipped template names the Beardy profile; its manifest selects the three bundle layers.
  const profileDir = join(root, 'home', 'profiles', 'beardy')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-beardy', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-beardy'] } },
  }, null, 2)}\n`)
  const result = await execa(process.execPath,
    ['--import', tsxHook, bin, '--profile', 'beardy', '--patch', patchPath, '--no-open', '--port', '0'], {
      cwd: repoRoot,
      env: { ...clearedProxyEnv(), DSH_HOME: join(root, 'home'), DSH_TELEMETRY_DISABLED: '1',
        DSH_RESEARCH_TEST_KEY: process.env.DSH_RESEARCH_LLM_API_KEY ?? 'keyless-local-fixture' },
      reject: false, timeout: options.fixtureOrigin === undefined ? 1_900_000 : 120_000, killSignal: 'SIGKILL',
    })
  const diagnostic = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  expect(result.timedOut, diagnostic).toBe(false)
  expect(result.signal, diagnostic).toBeUndefined()
  expect(result.exitCode, diagnostic).toBe(0)
  const records = result.stdout.split('\n').filter(line => line.startsWith('DSH_RESEARCH_E2E '))
  expect(records, diagnostic).toHaveLength(1)
  return JSON.parse(records[0]!.slice('DSH_RESEARCH_E2E '.length)) as ResearchDriverEvidence
}

function assertEvidence(first: ResearchDriverEvidence, second: ResearchDriverEvidence): void {
  expect(first.phase).toBe('run')
  expect(first.firstStatus).toBe('completed')
  expect(first.secondStatus).toBe('cancelled')
  expect(first.simultaneousRuns).toBe(true)
  expect(first.foreignDenied).toBe(true)
  expect(first.fetchedUrls?.length).toBeGreaterThanOrEqual(2)
  expect(first.sourceUrls).toEqual(first.fetchedUrls)
  const sources = new Set(first.sourceUrls)
  for (const url of first.sourceUrls ?? []) expect(new URL(url).protocol).toMatch(/^https?:$/)
  const citations = [...(first.report ?? '').matchAll(/https?:\/\/[^\s<>)\]]+/gu)]
    .map(match => match[0].replace(/[.,;]+$/u, ''))
  expect(citations.length).toBeGreaterThanOrEqual(2)
  for (const citation of citations) expect(sources.has(citation)).toBe(true)
  expect(second.phase).toBe('reopen')
  expect(second.runId).toBe(first.runId)
  expect(second.reopened).toBe(first.report)
  expect(second.foreignDenied).toBe(true)
}

describe('Beardy native research through dsh', () => {
  it('runs with local search/fetch and a scripted one-slot model, then reopens from the same DSH_HOME', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-beardy-research-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const server = await fixtureServer()
    onTestFinished(() => server.close())
    const proxy = await modelProxy(`${server.origin}/v1`)
    onTestFinished(() => proxy.close())
    const options = { provider: 'research-fixture', model: 'fixture-model',
      baseURL: proxy.baseURL, searxng: server.origin, fixtureOrigin: server.origin }
    const first = await launch(root, 'run', options)
    const second = await launch(root, 'reopen', { ...options, runId: first.runId })
    assertEvidence(first, second)
    expect(server.searches).toBeGreaterThan(0)
    expect(server.pages).toBeGreaterThanOrEqual(2)
    expect(server.modelRequests).toBeGreaterThanOrEqual(6)
    expect(server.maxActiveModels).toBe(1)
    expect(proxy.modelRequests).toBeGreaterThanOrEqual(6)
    expect(proxy.maxActiveModels).toBe(1)
  }, 150_000)

  it.skipIf(!runLive)('uses explicitly selected remote model and search endpoints', async () => {
    const baseURL = live.baseURL!
    const provider = live.provider!
    const model = live.model!
    const searxng = live.searxng!
    assertAllowedEndpoint(baseURL)
    assertAllowedEndpoint(searxng)
    const root = await mkdtemp(join(tmpdir(), 'dsh-beardy-research-live-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const proxy = await modelProxy(baseURL)
    onTestFinished(() => proxy.close())
    const options = { provider, model, baseURL: proxy.baseURL, searxng }
    const first = await launch(root, 'run', options)
    const second = await launch(root, 'reopen', { ...options, runId: first.runId })
    assertEvidence(first, second)
    expect(proxy.modelRequests).toBeGreaterThanOrEqual(6)
    expect(proxy.maxActiveModels).toBe(1)
  }, 1_950_000)
})
