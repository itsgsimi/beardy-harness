import { describe, expect, it } from 'vitest'
import { SearxngSearchProvider } from '@deepseek-ai/dsh-web-search-searxng'

/** Live SearXNG smoke; it runs only when a deployment supplies an endpoint. */
const baseURL = process.env.SEARXNG_BASE_URL
const maybe = baseURL !== undefined && baseURL.length > 0 ? describe : describe.skip

maybe('SearXNG search provider real API', () => {
  it('returns citeable sources for a live query', async () => {
    const result = await new SearxngSearchProvider({ baseURL: baseURL! })
      .search({ query: 'DeepSeek Harness', maxResults: 5 })
    expect(result.sources.length).toBeGreaterThan(0)
    for (const source of result.sources) expect(source.url.length).toBeGreaterThan(0)
  }, 30_000)
})
