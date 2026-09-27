import { describe, expect, it } from 'vitest'
import type { WebFetchResult } from '@deepseek-ai/dsh-web'
import { collect, localDate, parseFeed, parseWeather, type FetchSource } from '../src/collector.ts'
import { at, collectorConfig, item, response, rss, weather } from './fixtures.ts'

const feed = collectorConfig.feeds[0]!
const live = { firedAt: at, signal: new AbortController().signal }
const bySource = (feeds: Record<string, string>, weatherBody = weather): FetchSource =>
  async ({ url }) => response(url === collectorConfig.weather.url ? weatherBody : feeds[url] ?? rss(''))

describe('feed parsing', () => {
  it('keeps dated RSS entries inside the lookback, newest first, with decoded bounded text', () => {
    const raw = rss(item('Older', 'https://a.example/older', 'Mon, 07 Sep 2026 12:00:00 GMT')
      + item('Current', 'https://a.example/current#comments')
      + item('Stale', 'https://a.example/stale', 'Sat, 05 Sep 2026 12:00:00 GMT')
      + item('Future', 'https://a.example/future', 'Wed, 09 Sep 2026 12:00:00 GMT')
      + item('Undated', 'https://a.example/undated', 'not a date')
      + item('', 'https://a.example/untitled')
      + '<item><title>Linkless</title><pubDate>Tue, 08 Sep 2026 12:00:00 GMT</pubDate></item>')
    const result = parseFeed(raw, feed, collectorConfig, at)
    expect(result.items.map(entry => [entry.title, entry.url])).toEqual([
      ['Current', 'https://a.example/current'], ['Older', 'https://a.example/older'],
    ])
    expect(result.items[0]).toMatchObject({ source: 'A', summary: 'A & B summary', publishedAt: '2026-09-08T12:00:00.000Z' })
    expect(result).toMatchObject({ entriesRead: 7, updatedAt: null })
    const clipped = parseFeed(raw, feed, { ...collectorConfig, summaryChars: 5, titleChars: 4, itemsPerFeed: 1 }, at)
    expect(clipped.items).toEqual([expect.objectContaining({ title: 'Cur…', summary: 'A & …' })])
  })

  it('reads Atom alternate links, dates, and text fields and skips unusable links', () => {
    const entry = (body: string): string => `<entry><title type="html">Atom &lt;b&gt;story&lt;/b&gt;</title>${body}</entry>`
    const raw = '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/"><updated>2026-09-08T13:00:00Z</updated>'
      + entry('<updated>2026-09-08T12:00:00Z</updated><link rel="self" href="/api/1"/><link rel="alternate" href="/story/1"/><summary>Details</summary>')
      + entry('<published>2026-09-08T11:00:00Z</published><link href="https://a.example/story/2"/><content>Body</content>')
      + entry('<dc:date>2026-09-08T10:00:00Z</dc:date><link rel="self" href="/api/3"/>')
      + entry('<updated>2026-09-08T09:00:00Z</updated><link href="mailto:news@a.example"/>')
      + entry('<updated>2026-09-08T08:00:00Z</updated><link href="http://[bad"/>')
      + '</feed>'
    const result = parseFeed(raw, feed, collectorConfig, at)
    expect(result.items.map(story => [story.title, story.url, story.summary])).toEqual([
      ['Atom story', 'https://a.example/story/1', 'Details'],
      ['Atom story', 'https://a.example/story/2', 'Body'],
    ])
    expect(result.updatedAt).toBe('2026-09-08T13:00:00Z')
  })

  it('reads RSS content:encoded summaries, channel build dates, and repeated channel roots', () => {
    const raw = '<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><lastBuildDate>Tue, 08 Sep 2026 13:00:00 GMT</lastBuildDate>'
      + '<item><title>Encoded</title><link>https://a.example/e</link><pubDate>Tue, 08 Sep 2026 12:00:00 GMT</pubDate><content:encoded>Full text</content:encoded></item>'
      + '</channel></rss>'
    expect(parseFeed(raw, feed, collectorConfig, at)).toMatchObject({
      updatedAt: 'Tue, 08 Sep 2026 13:00:00 GMT', items: [{ summary: 'Full text' }],
    })
    expect(parseFeed('<rss><channel/><channel/></rss>', feed, collectorConfig, at)).toEqual({ updatedAt: null, items: [], entriesRead: 0 })
  })

  it('rejects document type declarations, incomplete XML, and other roots', () => {
    expect(() => parseFeed('<!DOCTYPE x><rss/>', feed, collectorConfig, at)).toThrow(/document type/)
    expect(() => parseFeed('<rss><channel>', feed, collectorConfig, at)).toThrow(/complete, valid XML/)
    expect(() => parseFeed('<root/>', feed, collectorConfig, at)).toThrow(/not an RSS or Atom/)
    expect(() => parseFeed('<rss/>', feed, collectorConfig, at)).toThrow(/not an RSS or Atom/)
  })
})

describe('weather parsing', () => {
  it('selects the forecast for the brief date and keeps unavailable numbers null', () => {
    expect(localDate(Date.parse('2026-09-08T04:05:00Z'), collectorConfig.timezone)).toBe('2026-09-07')
    expect(parseWeather(weather, collectorConfig.weather, '2026-09-08')).toEqual({
      location: 'Phoenix', date: '2026-09-08', highF: 103, lowF: 84, highC: 39, lowC: 29,
      uvIndex: null, rainChancePct: 9, sourceUrl: 'https://weather.example/j1',
    })
    expect(parseWeather(weather, collectorConfig.weather, '2026-09-07')).toMatchObject({ highC: null, rainChancePct: null })
  })

  it('refuses a missing date, a missing Fahrenheit range, and non-JSON text', () => {
    expect(() => parseWeather(weather, collectorConfig.weather, '2026-09-09')).toThrow(/no forecast for 2026-09-09/)
    expect(() => parseWeather('null', collectorConfig.weather, '2026-09-08')).toThrow(/no forecast/)
    expect(() => parseWeather('{"weather":[{"date":"2026-09-08","maxtempF":"hot","mintempF":"84"}]}', collectorConfig.weather, '2026-09-08'))
      .toThrow(/high\/low/)
    expect(() => parseWeather('{"weather":{"date":"2026-09-08","maxtempF":"100"}}', collectorConfig.weather, '2026-09-08'))
      .toThrow(/high\/low/)
    expect(() => parseWeather('<html>', collectorConfig.weather, '2026-09-08')).toThrow(SyntaxError)
  })
})

describe('collection', () => {
  it('fetches each source once, takes stories from feeds in turn, and removes duplicate URLs and titles', async () => {
    const calls: string[] = []
    const fetch = bySource({
      'https://a.example/rss': rss(item('One', 'https://example.com/1') + item('Two', 'https://example.com/2')),
      'https://b.example/rss': rss(item('Same URL', 'https://example.com/1') + item('ONE', 'https://example.com/one')
        + item('Three', 'https://example.com/3')),
    })
    const packet = await collect(async (request, signal) => { calls.push(request.url); return await fetch(request, signal) },
      { ...collectorConfig, maxItems: 3 }, live)
    expect(calls.sort()).toEqual([...collectorConfig.feeds.map(source => source.url), collectorConfig.weather.url].sort())
    expect(packet.items.map(story => story.url)).toEqual(['https://example.com/1', 'https://example.com/2', 'https://example.com/3'])
    expect(packet).toMatchObject({
      briefDate: '2026-09-08', timezone: 'America/Phoenix', scheduledFor: '2026-09-08T14:05:00.000Z',
      weather: { date: '2026-09-08', highF: 103 },
    })
    expect(packet.sources.map(({ fetchedAt: _fetchedAt, ...source }) => source)).toEqual([
      { name: 'A', url: 'https://a.example/rss', status: 'ok', entriesRead: 2, updatedAt: null },
      { name: 'B', url: 'https://b.example/rss', status: 'ok', entriesRead: 3, updatedAt: null },
      { name: 'Weather', url: 'https://weather.example/j1', status: 'ok' },
    ])
    expect(packet.sources.every(source => !Number.isNaN(Date.parse(source.fetchedAt)))).toBe(true)
  })

  it('stops selecting at maxItems', async () => {
    const packet = await collect(bySource({
      'https://a.example/rss': rss(item('One', 'https://example.com/1') + item('Two', 'https://example.com/2')),
      'https://b.example/rss': rss(item('Three', 'https://example.com/3')),
    }), { ...collectorConfig, maxItems: 2 }, live)
    expect(packet.items.map(story => story.title)).toEqual(['One', 'Three'])
  })

  it('reports partial failures as named gaps with a short cause and null weather', async () => {
    const packet = await collect(async ({ url }) => {
      if (url === 'https://a.example/rss') return response(rss(item('One', 'https://a.example/1')))
      if (url === 'https://b.example/rss') return { ...response('<rss>'), truncated: true }
      throw new Error(`Weather unavailable: ${'x'.repeat(400)}`)
    }, collectorConfig, live)
    expect(packet.items).toHaveLength(1)
    expect(packet.weather).toBeNull()
    expect(packet.sources.map(source => [source.name, source.status, source.error?.slice(0, 30)])).toEqual([
      ['A', 'ok', undefined], ['B', 'unavailable', 'Source response was truncated'], ['Weather', 'unavailable', 'Weather unavailable: xxxxxxxxx'],
    ])
    expect(packet.sources[2]!.error).toHaveLength(collectorConfig.summaryChars)
  })

  it('names HTTP status failures and non-Error rejections', async () => {
    const packet = await collect(async ({ url }) => {
      if (url === 'https://a.example/rss') return response('', 404)
      if (url === 'https://b.example/rss') return response('', 101)
      throw 'socket reset'
    }, { ...collectorConfig, feeds: [...collectorConfig.feeds, { name: 'C', url: 'https://c.example/rss' }] }, live).catch((error: unknown) => error)
    expect(String(packet)).toBe('Error: Brief collection failed: every source is unavailable (A: HTTP 404; B: HTTP 101; C: socket reset; Weather: socket reset)')
  })

  it('bounds a source that ignores its abort signal and refuses a wholly unavailable packet', async () => {
    await expect(collect(async () => await new Promise<WebFetchResult>(() => {}), { ...collectorConfig, timeoutMs: 5 }, live))
      .rejects.toThrow('every source is unavailable (A: Source fetch timed out; B: Source fetch timed out; Weather: Source fetch timed out)')
  })

  it('propagates run cancellation instead of reporting gaps', async () => {
    const run = new AbortController()
    const pending = collect(async (_request, signal) => await new Promise<WebFetchResult>((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new Error('aborted fetch')) }, { once: true })
    }), collectorConfig, { firedAt: at, signal: run.signal })
    run.abort(new Error('run cancelled'))
    await expect(pending).rejects.toThrow('run cancelled')
  })
})
