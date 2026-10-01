/** Per-player news search, fetch, name admission, and verbatim excerpts. @module @deepseek-ai/dsh-fantasy-reports/news */

import type { Context } from '@deepseek-ai/cordis'
import type { ResearchWorkflowRun } from '@deepseek-ai/dsh-research'
import type { FantasyPlayer } from '@deepseek-ai/dsh-fantasy/types'
import { renderBody } from '@deepseek-ai/dsh-tool-web/conversion'
import type {} from '@deepseek-ai/dsh-web'
import type { ResolvedConfig } from './config.ts'
import type { Excerpt } from './facts.ts'
import { admitsPlayer, cleanSource, fetchable, isDefense, playerExcerpt, playerPassages } from './sources.ts'

/** One admitted page as committed to the run. */
export interface Evidence {
  /** Citation number. */
  readonly id: number
  readonly url: string
  readonly title: string
  /** Short roster ids the page was admitted for. */
  readonly players: readonly string[]
  /** Exact committed source text; excerpts are substrings of it. */
  readonly text: string
}

/** Admitted pages, each player's excerpts, and how many fetches failed. */
export interface News {
  readonly evidence: readonly Evidence[]
  /** Excerpts by roster id, in page order; players without an admitted page have none. */
  readonly excerpts: ReadonlyMap<string, readonly Excerpt[]>
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

function playerQueries(player: FantasyPlayer, season: string, week: number): string[] {
  const name = isDefense(player) ? `${player.name} defense` : `"${player.name}"`
  return [
    [name, player.nflTeam, `${season} week ${week} injury practice status`].filter(part => part !== undefined).join(' '),
    `${name} ${season} week ${week} fantasy start sit outlook`,
  ]
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
 * Search and fetch per roster player, admit pages that name the player, commit each admitted page's
 * passages as a cited source, and cut each player's excerpts from the committed text. Every search,
 * fetch failure, and admission decision enters the run.
 * @param ctx - consumer context with the web service.
 * @param config - search, fetch, and excerpt bounds.
 * @param players - roster players by short id, in roster order.
 * @param query - season and week used in search queries.
 * @param run - research run ledger.
 * @returns admitted pages, excerpts, and the failed fetch count.
 */
export async function collectNews(ctx: Context, config: ResolvedConfig, players: ReadonlyMap<string, FantasyPlayer>,
  query: { readonly season: string; readonly week: number }, run: ResearchWorkflowRun): Promise<News> {
  const fetches = new Map<string, Promise<FetchedPage | undefined>>()
  const admitted = new Map<string, string[]>([...players.keys()].map(id => [id, []]))
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
  await eachLimited([...players], config.maxConcurrentFetches, async ([id, player]) => {
    const kept = admitted.get(id) as string[]
    for (const search of playerQueries(player, query.season, query.week).slice(0, config.searchesPerPlayer)) {
      if (kept.length >= config.pagesPerPlayer) break
      let results: Awaited<ReturnType<Context['web']['search']>>
      try {
        results = await ctx.web.search({ query: search, maxResults: config.searchResultsPerQuery }, run.signal)
      } catch (error) {
        run.signal.throwIfAborted()
        await run.search({ round: 1, query: search, status: 'error', urls: [], reason: String(error) })
        continue
      }
      await run.search({ round: 1, query: search, status: 'ok', urls: results.sources.map(source => source.url) })
      for (const candidate of results.sources) {
        if (kept.length >= config.pagesPerPlayer) break
        if (!fetchable(candidate.url, config.excludedHosts)) continue
        let pending = fetches.get(candidate.url)
        if (pending === undefined) {
          pending = fetchPage(candidate.url, candidate.title)
          fetches.set(candidate.url, pending)
        }
        const page = await pending
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
  const order: string[] = []
  for (const urls of admitted.values()) for (const url of urls) if (!order.includes(url)) order.push(url)
  const evidence: Evidence[] = []
  for (const [index, url] of order.entries()) {
    const page = pages.get(url) as FetchedPage
    const ids = [...admitted].filter(([, urls]) => urls.includes(url)).map(([id]) => id)
    const text = playerPassages(page.clean, ids.map(id => players.get(id) as FantasyPlayer), config.sourceExcerptChars)
    await run.fetched({ round: 1, requestedUrl: page.requestedUrl, url, title: page.title, statusCode: page.statusCode,
      retrievedAt: page.retrievedAt, text, truncated: page.truncated || text.length < page.clean.length })
    await run.finding({ round: 1, url, accepted: true })
    evidence.push({ id: index + 1, url, title: page.title, players: ids, text })
  }
  const excerpts = new Map([...players].map(([id, player]) => [id, evidence.filter(source => source.players.includes(id))
    .slice(0, config.excerptsPerPlayer)
    .map(source => ({ source: source.id, text: playerExcerpt(source.text, player, config.excerptChars) }))]))
  return { evidence, excerpts, failedFetches }
}
