/** RSS/Atom and daily-weather collection for a bounded cron evidence packet. */
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { decodeHTML } from 'entities'
import type { WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'

/** One named feed; the name labels its stories and its entry in the packet's source list. */
export interface FeedConfig {
  /** Source name shown to the model. */
  readonly name: string
  /** Absolute HTTP(S) RSS 2.0 or Atom URL. */
  readonly url: string
}

/** The forecast source for the brief's calendar date. */
export interface WeatherConfig {
  /** Location label copied into the packet. */
  readonly city: string
  /** Absolute HTTP(S) URL returning wttr.in `format=j1` JSON. */
  readonly url: string
}

/** Sources and per-packet limits; every field is required. */
export interface CollectorConfig {
  /** IANA timezone that decides the brief's calendar date. */
  readonly timezone: string
  /** Feeds fetched concurrently; stories are taken from them in turn. */
  readonly feeds: FeedConfig[]
  /** Daily forecast source, reported as the `Weather` source. */
  readonly weather: WeatherConfig
  /** Newest qualifying entries kept from each feed. */
  readonly itemsPerFeed: number
  /** Stories in the packet across all feeds. */
  readonly maxItems: number
  /** Oldest accepted entry, in hours before the scheduled fire. */
  readonly lookbackHours: number
  /** Deadline for each source fetch, in milliseconds. */
  readonly timeoutMs: number
  /** Character cap for each story title. */
  readonly titleChars: number
  /** Character cap for each story summary and each source failure cause. */
  readonly summaryChars: number
}

/** One dated story retained from RSS or Atom. */
export interface BriefItem {
  readonly source: string
  readonly title: string
  readonly url: string
  readonly publishedAt: string
  readonly summary: string
}

/** Parsed feed entries and metadata, before cross-feed selection. */
export interface ParsedFeed {
  readonly updatedAt: string | null
  readonly items: BriefItem[]
  readonly entriesRead: number
}

/** Weather values for exactly the brief's local date. Missing numeric fields are null. */
export interface BriefWeather {
  readonly location: string
  readonly date: string
  readonly highF: number
  readonly lowF: number
  readonly highC: number | null
  readonly lowC: number | null
  readonly uvIndex: number | null
  readonly rainChancePct: number | null
  readonly sourceUrl: string
}

/** One source's result; an unavailable source carries a short cause, and feeds report entry counts. */
export interface BriefSource {
  readonly name: string
  readonly url: string
  readonly fetchedAt: string
  readonly status: 'ok' | 'unavailable'
  readonly error?: string
  readonly entriesRead?: number
  readonly updatedAt?: string | null
}

/** Complete evidence given to the brief model. */
export interface BriefPacket {
  readonly briefDate: string
  readonly timezone: string
  readonly scheduledFor: string
  readonly collectedAt: string
  readonly items: BriefItem[]
  readonly weather: BriefWeather | null
  readonly sources: BriefSource[]
}

/** Fetch seam: the Host Web service in production, a fixture in tests. */
export type FetchSource = (request: WebFetchRequest, signal: AbortSignal) => Promise<WebFetchResult>

type Outcome<T> =
  | { readonly status: 'ok'; readonly fetchedAt: string; readonly data: T }
  | { readonly status: 'unavailable'; readonly fetchedAt: string; readonly error: string }

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  processEntities: true,
})

const WEATHER_SOURCE_NAME = 'Weather'

/** Parsed XML and JSON are untrusted trees; read one named member of an object node. */
const child = (node: unknown, key: string): unknown =>
  node !== null && typeof node === 'object' && !Array.isArray(node) ? (node as Record<string, unknown>)[key] : undefined
const list = (value: unknown): unknown[] => value == null ? [] : Array.isArray(value) ? value : [value]
const valueText = (value: unknown): string => {
  const text = typeof value === 'string' ? value : child(value, '#text')
  return typeof text === 'string' ? text : ''
}
const plain = (value: unknown): string => decodeHTML(valueText(value)).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
const clip = (value: string, limit: number): string => value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
const number = (value: unknown): number | null =>
  (typeof value === 'string' && value !== '') || typeof value === 'number'
    ? Number.isFinite(Number(value)) ? Number(value) : null
    : null

/**
 * Calendar date at the cron fire in its configured timezone.
 * @param at - Scheduled fire timestamp.
 * @param timezone - Valid IANA timezone.
 * @returns YYYY-MM-DD local date.
 */
export function localDate(at: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(at)
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${fields.year}-${fields.month}-${fields.day}`
}

/**
 * Parse recent RSS/Atom entries, preserving full links and publication dates.
 * @param raw - Complete XML response text.
 * @param feed - Source name and base URL for relative links.
 * @param config - Lookback, count, and text limits.
 * @param at - Scheduled fire timestamp; later entries are excluded.
 * @returns Newest qualifying entries, at most `itemsPerFeed`.
 * @throws for a document type declaration, incomplete XML, or a root other than RSS or Atom.
 */
export function parseFeed(raw: string, feed: FeedConfig, config: CollectorConfig, at: number): ParsedFeed {
  if (/<!DOCTYPE/i.test(raw)) throw new Error('Feed contains an unsupported document type declaration')
  // oxlint-disable-next-line typescript/no-deprecated -- its replacement, fast-xml-validator, is not a workspace dependency.
  if (XMLValidator.validate(raw) !== true) throw new Error('Feed is not complete, valid XML')
  const xml: unknown = parser.parse(raw)
  const container = child(child(xml, 'rss'), 'channel') ?? child(xml, 'feed')
  if (!container) throw new Error('Response is not an RSS or Atom feed')
  const entries = list(child(container, 'item') ?? child(container, 'entry'))
  const oldest = at - config.lookbackHours * 3_600_000
  const items: BriefItem[] = []
  for (const entry of entries) {
    const title = plain(child(entry, 'title'))
    const links = list(child(entry, 'link'))
    const alternate = links.find(link => typeof link === 'object'
      && (child(link, '@_rel') === undefined || child(link, '@_rel') === 'alternate'))
    const href = valueText(child(alternate, '@_href')) || links.map(valueText).find(Boolean)
    const stamp = Date.parse(valueText(child(entry, 'pubDate') ?? child(entry, 'published')
      ?? child(entry, 'updated') ?? child(entry, 'date')))
    if (!title || !href || !Number.isFinite(stamp) || stamp < oldest || stamp > at) continue
    let url: URL
    // An unparsable entry link excludes only that entry; the rest of the feed stays usable.
    try { url = new URL(href, feed.url) } catch { continue }
    if (!['https:', 'http:'].includes(url.protocol)) continue
    url.hash = ''
    items.push({
      source: feed.name,
      title: clip(title, config.titleChars),
      url: url.href,
      publishedAt: new Date(stamp).toISOString(),
      summary: clip(plain(child(entry, 'description') ?? child(entry, 'summary')
        ?? child(entry, 'content') ?? child(entry, 'encoded')), config.summaryChars),
    })
  }
  items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
  return {
    updatedAt: valueText(child(container, 'lastBuildDate') ?? child(container, 'updated')) || null,
    items: items.slice(0, config.itemsPerFeed),
    entriesRead: entries.length,
  }
}

/**
 * Read the forecast matching the brief's local date.
 * @param raw - wttr.in `format=j1` JSON text.
 * @param weather - Location label and source URL.
 * @param date - Brief local date.
 * @returns Dated forecast with unavailable numeric fields as null.
 * @throws when the JSON is invalid, the date is absent, or the Fahrenheit range is missing.
 */
export function parseWeather(raw: string, weather: WeatherConfig, date: string): BriefWeather {
  const data: unknown = JSON.parse(raw)
  const day = list(child(data, 'weather')).find(entry => child(entry, 'date') === date)
  if (day === undefined) throw new Error(`Weather response has no forecast for ${date}`)
  const highF = number(child(day, 'maxtempF'))
  const lowF = number(child(day, 'mintempF'))
  if (highF === null || lowF === null) throw new Error('Weather forecast is missing high/low temperatures')
  const rain = list(child(day, 'hourly')).map(hour => number(child(hour, 'chanceofrain')))
    .filter((value): value is number => value !== null)
  return {
    location: weather.city, date,
    highF, lowF, highC: number(child(day, 'maxtempC')), lowC: number(child(day, 'mintempC')),
    uvIndex: number(child(day, 'uvIndex')),
    rainChancePct: rain.length ? Math.max(...rain) : null,
    sourceUrl: weather.url,
  }
}

/**
 * Fetch one source within its deadline and parse its text. A failure becomes an
 * unavailable outcome with a clipped cause; cancellation of the run propagates.
 */
async function attempt<T>(
  fetchSource: FetchSource, url: string, parse: (raw: string) => T,
  config: CollectorConfig, signal: AbortSignal,
): Promise<Outcome<T>> {
  const timeout = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  // The race also ends a fetch implementation that ignores its abort signal.
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Source fetch timed out')
      timeout.abort(error)
      reject(error)
    }, config.timeoutMs)
  })
  try {
    const response = await Promise.race([fetchSource({ url }, AbortSignal.any([signal, timeout.signal])), deadline])
    if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`HTTP ${response.statusCode}`)
    if (response.truncated) throw new Error('Source response was truncated')
    return { status: 'ok', fetchedAt: new Date().toISOString(), data: parse(response.body.content) }
  } catch (error) {
    signal.throwIfAborted()
    const cause = timeout.signal.aborted ? 'Source fetch timed out'
      : error instanceof Error ? error.message : String(error)
    return { status: 'unavailable', fetchedAt: new Date().toISOString(), error: clip(cause, config.summaryChars) }
  } finally {
    clearTimeout(timer)
  }
}

/** Project one outcome into the packet's source list; feeds add their entry counts. */
function report(name: string, url: string, outcome: Outcome<unknown>, feed?: ParsedFeed): BriefSource {
  const base = { name, url, fetchedAt: outcome.fetchedAt }
  if (outcome.status === 'unavailable') return { ...base, status: 'unavailable', error: outcome.error }
  return feed === undefined ? { ...base, status: 'ok' }
    : { ...base, status: 'ok', entriesRead: feed.entriesRead, updatedAt: feed.updatedAt }
}

/**
 * Fetch every configured source concurrently, retaining partial failures as named gaps.
 * @param fetchSource - Host Web fetch service or a fixture replacement.
 * @param config - Sources and limits validated at plugin load.
 * @param fire - Scheduled fire time and run cancellation signal.
 * @returns Packet with round-robin selected stories, the dated forecast or null, and every source's status.
 * @throws when every source is unavailable, naming each cause, or when the run is cancelled.
 */
export async function collect(
  fetchSource: FetchSource,
  config: CollectorConfig,
  fire: { readonly firedAt: number; readonly signal: AbortSignal },
): Promise<BriefPacket> {
  const { firedAt, signal } = fire
  const date = localDate(firedAt, config.timezone)
  const [feeds, weather] = await Promise.all([
    Promise.all(config.feeds.map(async feed => ({
      feed,
      outcome: await attempt(fetchSource, feed.url, raw => parseFeed(raw, feed, config, firedAt), config, signal),
    }))),
    attempt(fetchSource, config.weather.url, raw => parseWeather(raw, config.weather, date), config, signal),
  ])
  const sources = [
    ...feeds.map(({ feed, outcome }) =>
      report(feed.name, feed.url, outcome, outcome.status === 'ok' ? outcome.data : undefined)),
    report(WEATHER_SOURCE_NAME, config.weather.url, weather),
  ]
  if (sources.every(source => source.status === 'unavailable')) {
    const causes = sources.map(source => `${source.name}: ${source.error}`).join('; ')
    throw new Error(`Brief collection failed: every source is unavailable (${causes})`)
  }
  const items: BriefItem[] = []
  const seenUrls = new Set<string>()
  const seenTitles = new Set<string>()
  // Round-robin selection keeps feed diversity without a model ranking pass.
  for (let index = 0; index < config.itemsPerFeed && items.length < config.maxItems; index++) {
    for (const { outcome } of feeds) {
      const item = outcome.status === 'ok' ? outcome.data.items[index] : undefined
      if (item === undefined || items.length === config.maxItems) continue
      const title = item.title.toLocaleLowerCase('en-US')
      if (seenUrls.has(item.url) || seenTitles.has(title)) continue
      seenUrls.add(item.url)
      seenTitles.add(title)
      items.push(item)
    }
  }
  return {
    briefDate: date, timezone: config.timezone,
    scheduledFor: new Date(firedAt).toISOString(),
    collectedAt: new Date().toISOString(),
    items,
    weather: weather.status === 'ok' ? weather.data : null,
    sources,
  }
}
