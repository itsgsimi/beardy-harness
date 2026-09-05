import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import {
  SearxngSearchProvider,
  SEARXNG_PROVIDER_ID,
} from '@deepseek-ai/dsh-web-search-searxng'
import * as searxngPlugin from '@deepseek-ai/dsh-web-search-searxng'
import {
  mapSearxngResponse,
  mapSearxngResult,
  parseSearxngResponse,
} from '../src/provider.ts'

const options = { baseURL: 'http://searxng.test' }

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SearXNG result mapping', () => {
  it('maps a full result entry', () => {
    expect(mapSearxngResult({
      url: 'https://a.test',
      title: ' A ',
      content: ' a useful snippet ',
      publishedDate: ' 2026-01-01 ',
    })).toEqual({
      url: 'https://a.test',
      title: 'A',
      snippet: 'a useful snippet',
      publishedAt: '2026-01-01',
    })
  })

  it('omits blank optional fields and drops a blank URL', () => {
    expect(mapSearxngResult({ url: ' https://a.test ', title: ' ', content: null, publishedDate: '' }))
      .toEqual({ url: 'https://a.test' })
    expect(mapSearxngResult({ url: '  ' })).toBeUndefined()
  })

  it('maps a response and keeps provider-generated content absent', () => {
    expect(mapSearxngResponse({
      results: [
        { url: 'https://a.test', content: 'one' },
        { url: 'https://b.test', title: 'B' },
        { url: 'https://c.test', content: '  ' },
      ],
    })).toEqual({
      sources: [
        { url: 'https://a.test', snippet: 'one' },
        { url: 'https://b.test', title: 'B' },
        { url: 'https://c.test' },
      ],
      truncated: false,
    })
  })

  it('validates the response envelope and consumed fields', () => {
    expect(parseSearxngResponse({ results: [{ url: 'https://a.test', content: null }] }))
      .toEqual({ results: [{ url: 'https://a.test', content: null }] })
    expect(parseSearxngResponse({
      results: [
        { url: 'https://a.test', title: 'A', content: 'snippet', publishedDate: '2026-01-01' },
        { url: 'https://b.test' },
      ],
    })).toEqual({
      results: [
        { url: 'https://a.test', title: 'A', content: 'snippet', publishedDate: '2026-01-01' },
        { url: 'https://b.test' },
      ],
    })
    expect(() => parseSearxngResponse({})).toThrow('response.results must be an array')
    expect(() => parseSearxngResponse({ results: [null] })).toThrow('must be an object')
    expect(() => parseSearxngResponse({ results: [{ url: 42 }] })).toThrow('.url must be a string')
    expect(() => parseSearxngResponse({ results: [{ url: 'https://a.test', content: 42 }] }))
      .toThrow('.content must be a string or null')
  })
})

describe('SearxngSearchProvider availability', () => {
  it('is available for an absolute HTTP(S) URL', () => {
    expect(new SearxngSearchProvider(options).available()).toBe(true)
    expect(new SearxngSearchProvider({ baseURL: 'https://search.example/searxng/' }).available()).toBe(true)
  })

  it('rejects an invalid, non-HTTP, credential-bearing, or stateful base URL', () => {
    for (const baseURL of [
      '',
      'not a url',
      'ftp://search.example',
      'http://user:pass@search.example',
      'http://search.example/?token=secret',
      'http://search.example/#fragment',
    ]) {
      expect(new SearxngSearchProvider({ baseURL }).available()).toBe(false)
    }
  })
})

describe('SearxngSearchProvider request mapping', () => {
  it('sends a GET JSON search request without credentials', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [{ url: 'https://a.test', content: 'hi' }] }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    await new SearxngSearchProvider({ baseURL: 'http://searxng.test/searxng/' })
      .search({ query: 'hello world' }, controller.signal)

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://searxng.test/searxng/search?q=hello+world&format=json')
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', signal: controller.signal })
    expect(init.headers).toEqual({ accept: 'application/json', 'user-agent': 'deepseek-harness/0.1.2-alpha.1' })
    expect(init).not.toHaveProperty('body')
  })

  it('rejects an invalid base URL when a search is attempted', async () => {
    await expect(new SearxngSearchProvider({ baseURL: 'not a url' }).search({ query: 'q' }))
      .rejects.toThrow('SearXNG baseURL must be an absolute HTTP(S) URL')
  })
})

describe('SearxngSearchProvider error handling', () => {
  it('maps an HTTP error to WEB_PROVIDER_ERROR with the provider message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'JSON format is disabled' }, { status: 403 })))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'JSON format is disabled' }))
  })

  it('keeps an HTTP status message for a non-JSON error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway down', { status: 502 })))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'SearXNG API error (HTTP 502)' }))

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([], { status: 502 })))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'SearXNG API error (HTTP 502)' }))

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'instance unavailable' }, { status: 502 })))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'instance unavailable' }))

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: '' }, { status: 502 })))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'SearXNG API error (HTTP 502)' }))
  })

  it('maps a network failure and an abort to the shared error codes', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))

    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps an unparseable or wrong-shape success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: {} })))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('surfaces an abort during body parsing as WEB_ABORTED', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('surfaces an abort while reading an HTTP error body as WEB_ABORTED', async () => {
    const body = {
      json: () => Promise.reject(new DOMException('aborted', 'AbortError')),
      ok: false,
      status: 502,
    }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})

describe('web-search-searxng plugin registration', () => {
  it('registers the provider into ctx.web and disposes it with the plugin fiber', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [] })))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: SEARXNG_PROVIDER_ID })
    const fiber = await ctx.plugin(searxngPlugin, options)
    await expect(ctx.web.search({ query: 'q' })).resolves.toEqual({ sources: [], truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in searxngPlugin).toBe(false)
  })

  it('falls back to SEARXNG_BASE_URL when config omits the endpoint', async () => {
    const previous = process.env.SEARXNG_BASE_URL
    process.env.SEARXNG_BASE_URL = 'http://env-searxng.test'
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: SEARXNG_PROVIDER_ID })
      const fiber = await ctx.plugin(searxngPlugin, {})
      await ctx.web.search({ query: 'q' })
      expect((fetchMock.mock.calls[0] as unknown as [string])[0])
        .toBe('http://env-searxng.test/search?q=q&format=json')
      await fiber.dispose()
    } finally {
      if (previous === undefined) delete process.env.SEARXNG_BASE_URL
      else process.env.SEARXNG_BASE_URL = previous
    }
  })

  it('is unavailable when neither config nor environment supplies an endpoint', async () => {
    const previous = process.env.SEARXNG_BASE_URL
    delete process.env.SEARXNG_BASE_URL
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: SEARXNG_PROVIDER_ID })
      await ctx.plugin(searxngPlugin, {})
      await expect(ctx.web.search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))
    } finally {
      if (previous !== undefined) process.env.SEARXNG_BASE_URL = previous
    }
  })
})
