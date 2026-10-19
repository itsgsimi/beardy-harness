/**
 * Per-player news search, the waiver-article sweep, fetch, name admission, and verbatim excerpts.
 * @module @deepseek-ai/dsh-fantasy-reports/news
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ResearchWorkflowRun } from '@deepseek-ai/dsh-research'
import type { FantasyPlayer } from '@deepseek-ai/dsh-fantasy/types'
import { renderBody } from '@deepseek-ai/dsh-tool-web/conversion'
import type {} from '@deepseek-ai/dsh-web'
import type { ResolvedConfig } from './config.ts'
import type { Excerpt } from './facts.ts'
import { articleMentions } from './signals.ts'
import { admitsPlayer, cleanSource, fetchable, isDefense, playerExcerpt, playerPassages } from './sources.ts'

/** One admitted page as committed to the run. */
export interface Evidence {
  /** Citation number. */
  readonly id: number
  readonly url: string
  readonly title: string
  /** Short subject ids the page was admitted for; an article page naming no subject has none. */
  readonly players: readonly string[]
  /** Exact committed source text; excerpts are substrings of it. */
  readonly text: string
}

/** Admitted pages, each player's excerpts, and how many fetches failed. */
export interface News {
  readonly evidence: readonly Evidence[]
  /** Excerpts by subject id, in page order; subjects without an admitted page have none. */
  readonly excerpts: ReadonlyMap<string, readonly Excerpt[]>
  /** Admitted waiver-article pages naming each pool player, by player key; unnamed players are absent. */
  readonly mentions: ReadonlyMap<FantasyPlayer['key'], number>
  /** Waiver-article pages admitted. */
  readonly articles: number
  /** Fetches that failed by transport error or HTTP status. */
  readonly failedFetches: number
}

/** A fetched page before admission and windowing. */
interface FetchedPage {
  readonly url: string
  readonly requestedUrl: string
  readonly title: string
  readonly statusCode: number
  readonly retrievedAt: number
  readonly truncated: boolean
  readonly clean: string
}

/**
 * News queries for a roster player: availability first, then fantasy outlook.
 * @param player - roster player.
 * @param season - league season.
 * @param week - report week.
 * @returns both queries in order.
 */
export function rosterQueries(player: FantasyPlayer, season: string, week: number): string[] {
  const name = isDefense(player) ? `${player.name} defense` : `"${player.name}"`
  return [
    [name, player.nflTeam, `${season} week ${week} injury practice status`].filter(part => part !== undefined).join(' '),
    `${name} ${season} week ${week} fantasy start sit outlook`,
  ]
}

/**
 * The one news query for a shortlisted waiver candidate: his role, injuries around him, and pickup outlook.
 * @param player - available player.
 * @param season - league season.
 * @param week - report week.
 * @returns the query.
 */
export function candidateQuery(player: FantasyPlayer, season: string, week: number): string {
  const name = isDefense(player) ? `${player.name} defense` : `"${player.name}"`
  return [name, player.nflTeam, `${season} week ${week} fantasy waiver pickup role injury`].filter(part => part !== undefined).join(' ')
}

/** Waiver-article query templates, in the order a report uses them. */
const ARTICLE_QUERIES: ReadonlyArray<(season: string, week: number) => string> = [
  (season, week) => `fantasy football week ${week} waiver wire pickups ${season}`,
  (season, week) => `week ${week} waiver wire adds ${season} fantasy football rankings`,
  (season, week) => `${season} fantasy football week ${week} streaming kickers defenses`,
  (season, week) => `fantasy football week ${week} injuries waiver replacements ${season}`,
]

/**
 * Waiver-article search queries.
 * @param season - league season.
 * @param week - report week.
 * @param count - queries wanted, at most four.
 * @returns the first `count` queries.
 */
export function articleQueries(season: string, week: number, count: number): string[] {
  return ARTICLE_QUERIES.slice(0, count).map(query => query(season, week))
}

/** One player whose news a report gathers, with the queries searched for him. */
export interface NewsSubject {
  readonly player: FantasyPlayer
  readonly queries: readonly string[]
}

/** The waiver-article sweep: league-wide queries whose admitted pages count mentions of available players. */
export interface ArticleSweep {
  readonly queries: readonly string[]
  /** Most article pages admitted. */
  readonly pages: number
  /** Available players a page must name to be admitted, and whose mentions are counted. */
  readonly pool: readonly FantasyPlayer[]
}

async function eachLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) await work(items[cursor++] as T)
  }))
  const failure = outcomes.find(outcome => outcome.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
}

/**
 * Search and fetch per subject, admit pages that name the subject, run the waiver-article sweep, commit each
 * admitted page's passages as a cited source, and cut each subject's excerpts from the committed text. An
 * article page is admitted when it names an available player of the sweep's pool, and it also serves as
 * news for every subject it names. Every search, fetch failure, and admission decision enters the run.
 * @param ctx - consumer context with the web service.
 * @param config - search, fetch, and excerpt bounds.
 * @param subjects - roster players and shortlisted candidates by short id, with their queries, in report order.
 * @param run - research run ledger.
 * @param sweep - waiver-article queries, page bound, and pool; absent skips the sweep.
 * @returns admitted pages, excerpts, article mentions, and the failed fetch count.
 */
export async function collectNews(ctx: Context, config: ResolvedConfig, subjects: ReadonlyMap<string, NewsSubject>,
  run: ResearchWorkflowRun, sweep?: ArticleSweep): Promise<News> {
  const fetches = new Map<string, Promise<FetchedPage | undefined>>()
  const admitted = new Map<string, string[]>([...subjects.keys()].map(id => [id, []]))
  const pages = new Map<string, FetchedPage>()
  let failedFetches = 0
  const fetchPage = async (url: string, title: string | undefined): Promise<FetchedPage | undefined> => {
    const retrievedAt = Date.now()
    let result: Awaited<ReturnType<Context['web']['fetch']>>
    try {
      result = await ctx.web.fetch({ url }, run.signal)
    } catch (error) {
      run.signal.throwIfAborted()
      failedFetches++
      await run.failed({ round: 1, requestedUrl: url, retrievedAt, status: 'error', reason: String(error) })
      return undefined
    }
    if (result.statusCode < 200 || result.statusCode >= 300) {
      failedFetches++
      await run.failed({ round: 1, requestedUrl: url, finalUrl: result.url, statusCode: result.statusCode, retrievedAt, status: 'http_error' })
      return undefined
    }
    if (!fetchable(result.url, config.excludedHosts)) {
      await run.finding({ round: 1, url: result.url, accepted: false, reason: 'final URL is not an admissible HTTPS host' })
      return undefined
    }
    const rendered = renderBody(result.body, config.maxPageChars)
    return { url: result.url, requestedUrl: url, title: title ?? result.url, statusCode: result.statusCode, retrievedAt,
      truncated: result.truncated || rendered.sourceTruncated || rendered.text.length > config.maxPageChars,
      clean: cleanSource(result.url, rendered.text.slice(0, config.maxPageChars)) }
  }
  const shared = (url: string, title: string | undefined): Promise<FetchedPage | undefined> => {
    let pending = fetches.get(url)
    if (pending === undefined) {
      pending = fetchPage(url, title)
      fetches.set(url, pending)
    }
    return pending
  }
  const searched = async (query: string): Promise<Awaited<ReturnType<Context['web']['search']>>['sources']> => {
    try {
      const results = await ctx.web.search({ query, maxResults: config.searchResultsPerQuery }, run.signal)
      await run.search({ round: 1, query, status: 'ok', urls: results.sources.map(source => source.url) })
      return results.sources
    } catch (error) {
      run.signal.throwIfAborted()
      await run.search({ round: 1, query, status: 'error', urls: [], reason: String(error) })
      return []
    }
  }
  await eachLimited([...subjects], config.maxConcurrentFetches, async ([id, { player, queries }]) => {
    const kept = admitted.get(id) as string[]
    for (const search of queries) {
      if (kept.length >= config.pagesPerPlayer) break
      for (const candidate of await searched(search)) {
        if (kept.length >= config.pagesPerPlayer) break
        if (!fetchable(candidate.url, config.excludedHosts)) continue
        const page = await shared(candidate.url, candidate.title)
        if (page === undefined || kept.includes(page.url)) continue
        if (!admitsPlayer(player, page.clean)) {
          await run.finding({ round: 1, url: page.url, accepted: false, reason: `the page does not name ${player.name}` })
          continue
        }
        kept.push(page.url)
        pages.set(page.url, page)
      }
    }
  })
  const articles: string[] = []
  const pool = sweep?.pool ?? []
  for (const search of sweep?.queries ?? []) {
    const limit = (sweep as ArticleSweep).pages
    if (articles.length >= limit) break
    for (const candidate of await searched(search)) {
      if (articles.length >= limit) break
      if (!fetchable(candidate.url, config.excludedHosts)) continue
      const page = await shared(candidate.url, candidate.title)
      if (page === undefined || articles.includes(page.url)) continue
      if (articleMentions([page.clean], pool).size === 0) {
        await run.finding({ round: 1, url: page.url, accepted: false, reason: 'the page names no available player' })
        continue
      }
      articles.push(page.url)
      pages.set(page.url, page)
    }
  }
  const order: string[] = []
  for (const urls of [...admitted.values(), articles]) for (const url of urls) if (!order.includes(url)) order.push(url)
  const evidence: Evidence[] = []
  for (const [index, url] of order.entries()) {
    const page = pages.get(url) as FetchedPage
    const ids = [...subjects].filter(([id, { player }]) => (admitted.get(id) as string[]).includes(url)
      || (articles.includes(url) && admitsPlayer(player, page.clean))).map(([id]) => id)
    const named = ids.length > 0 ? ids.map(id => (subjects.get(id) as NewsSubject).player)
      : pool.filter(player => articleMentions([page.clean], [player]).size > 0)
    const text = playerPassages(page.clean, named, config.sourceExcerptChars)
    await run.fetched({ round: 1, requestedUrl: page.requestedUrl, url, title: page.title, statusCode: page.statusCode,
      retrievedAt: page.retrievedAt, text, truncated: page.truncated || text.length < page.clean.length })
    await run.finding({ round: 1, url, accepted: true })
    evidence.push({ id: index + 1, url, title: page.title, players: ids, text })
  }
  const excerpts = new Map([...subjects].map(([id, { player }]) => [id, evidence.filter(source => source.players.includes(id))
    .slice(0, config.excerptsPerPlayer)
    .map(source => ({ source: source.id, text: playerExcerpt(source.text, player, config.excerptChars) }))]))
  const mentions = articleMentions(articles.map(url => (pages.get(url) as FetchedPage).clean), pool)
  return { evidence, excerpts, mentions, articles: articles.length, failedFetches }
}
