import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { requestResearch as requestResponse } from '../src/request.ts'
import { Config } from '../src/index.ts'

const requestResearch = async (...args: Parameters<typeof requestResponse>) => (await requestResponse(...args)).text

const config = Config({ baseURL: 'http://odysseus.test', tokenEnv: 'TOKEN', endpointId: 'worker-4b',
  model: 'Qwen3.5-4B', maxRounds: 1, maxTimeSeconds: 60 }) as Required<Config>
const signal = () => new AbortController().signal
const reply = (value: unknown) => new Response(JSON.stringify(value))
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('Odysseus research requests', () => {
  it('starts exactly once with the configured worker and budget', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(reply({ session_id: 'rp-123', status: 'running' }))
    vi.stubGlobal('fetch', fetch)
    expect(await requestResearch(config, 'secret', { action: 'start', query: ' Research question ' }, signal()))
      .toBe('{"id":"rp-123","status":"running","model":"Qwen3.5-4B"}')
    expect(fetch).toHaveBeenCalledExactlyOnceWith('http://odysseus.test/api/research/start', expect.objectContaining({
      redirect: 'error', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: 'Research question', endpoint_id: 'worker-4b', model: 'Qwen3.5-4B', max_rounds: 1, max_time: 60 }),
    }))
  })

  it('disables thinking only when configured for the worker', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(reply({ session_id: 'rp-123', status: 'running' }))
    vi.stubGlobal('fetch', fetch)
    await requestResearch({ ...config, disableThinking: true }, 'secret', { action: 'start', query: 'Question' }, signal())
    expect((JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as { enable_thinking: boolean }).enable_thinking).toBe(false)
  })

  it('reads every Unicode report page without consuming the remote result', async () => {
    const report = { result: 'Evidence 🐻 漢字', sources: [{ url: 'https://example.org', title: 'Source' }] }
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => reply(report))
    vi.stubGlobal('fetch', fetch)
    let offset: number | null = 0
    let complete = ''
    while (offset !== null) {
      const page = JSON.parse(await requestResearch({ ...config, pageChars: 7 }, 'token',
        { action: 'report', id: 'rp-123', offset }, signal())) as { text: string; next_offset: number | null }
      expect(Array.from(page.text).length).toBeLessThanOrEqual(7)
      complete += page.text
      offset = page.next_offset
    }
    expect(JSON.parse(complete)).toEqual({ report: report.result, sources: report.sources })
    expect(fetch.mock.calls.every(([url]) => typeof url === 'string' && url.endsWith('/result-peek/rp-123'))).toBe(true)
  })

  it('lists active and saved jobs and keeps failed status distinct from completion', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(reply({ active: [{ session_id: 'rp-123' }] }))
      .mockResolvedValueOnce(reply({ research: [], total: 0 }))
      .mockResolvedValueOnce(reply({ status: 'error', progress: { stage: 'search' } }))
      .mockResolvedValueOnce(reply({ cancelled: false }))
    vi.stubGlobal('fetch', fetch)
    const list = JSON.parse(await requestResearch(config, 'token', { action: 'list', query: 'a&b' }, signal())) as { text: string }
    expect(JSON.parse(list.text)).toEqual({ active: [{ session_id: 'rp-123' }], saved: [], total_saved: 0 })
    expect(fetch.mock.calls[1]?.[0]).toContain('search=a%26b')
    const status = JSON.parse(await requestResearch(config, 'token', { action: 'status', id: 'rp-123' }, signal())) as { text: string }
    expect(JSON.parse(status.text)).toMatchObject({ status: 'error' })
    expect(await requestResearch(config, 'token', { action: 'cancel', id: 'rp-123' }, signal()))
      .toBe('{"id":"rp-123","cancellation_requested":false}')
  })

  it.each([
    { action: 'start', query: ' ' }, { action: 'status', id: '../secret' },
    { action: 'report' }, { action: 'list', offset: -1 }, { action: 'list', offset: 0.5 },
    { action: 'start', query: 'q', offset: 1 }, { action: 'delete', id: 'rp-123' },
  ])('rejects invalid input before sending: %j', async (args) => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(requestResearch(config, 'token', args, signal())).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([401, 403, 404, 429, 500])('does not retry HTTP %i or expose its body', async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('secret', { status })); vi.stubGlobal('fetch', fetch)
    await expect(requestResearch(config, 'token', { action: 'start', query: 'q' }, signal()))
      .rejects.toThrow(`HTTP ${status}`)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['start', { session_id: '../bad', status: 'running' }], ['start', { session_id: 'rp-123', status: 'error' }],
    ['cancel', { cancelled: 'yes' }], ['report', { result: null, sources: [] }],
    ['status', {}], ['status', []], ['list', { active: null }],
  ])('rejects malformed %s responses', async (action, response) => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async () => reply(response)))
    await expect(requestResearch(config, 'token', { action, query: 'q', id: 'rp-123' }, signal()))
      .rejects.toThrow()
  })

  it('bounds the complete HTTP body including a single oversized multibyte chunk', async () => {
    const body = JSON.stringify({ status: '🐻' })
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(body)))
    const bytes = Buffer.byteLength(body)
    await expect(requestResearch({ ...config, maxResponseBytes: bytes }, 'token', { action: 'status', id: 'rp-123' }, signal()))
      .resolves.toContain('🐻')
    await expect(requestResearch({ ...config, maxResponseBytes: bytes - 1 }, 'token', { action: 'status', id: 'rp-123' }, signal()))
      .rejects.toThrow('maxResponseBytes')
  })

  it('never contacts a redirect destination or forwards credentials to it', async () => {
    let targetHits = 0
    const server = createServer((req, res) => {
      if (req.url === '/target') { targetHits++; res.end('{}'); return }
      res.writeHead(307, { Location: '/target' }); res.end()
    })
    server.listen(0, '127.0.0.1')
    try {
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Expected TCP address')
      await expect(requestResearch({ ...config, baseURL: `http://127.0.0.1:${address.port}` },
        'secret', { action: 'start', query: 'q' }, signal())).rejects.toThrow()
      expect(targetHits).toBe(0)
    } finally {
      server.closeAllConnections()
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => { if (error) reject(error); else resolve() })
        })
      }
    }
  })

  it('keeps the deadline alive while reading the body and honors cancellation', async () => {
    vi.useFakeTimers()
    const reading = Promise.withResolvers<undefined>()
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener('abort', () => { controller.error(init?.signal?.reason) }, { once: true })
        reading.resolve(undefined)
      },
    }))))
    const controller = new AbortController()
    const pending = requestResearch({ ...config, requestTimeoutMs: 100 }, 'token', { action: 'status', id: 'rp-123' }, controller.signal)
    const rejected = expect(pending).rejects.toThrow('ODYSSEUS_REQUEST_TIMEOUT')
    await reading.promise
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    const cancelled = requestResearch(config, 'token', { action: 'status', id: 'rp-123' }, controller.signal)
    const aborted = expect(cancelled).rejects.toThrow('user cancelled')
    await Promise.resolve()
    controller.abort(new Error('user cancelled'))
    await aborted
  })
})
