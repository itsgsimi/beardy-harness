/**
 * SearXNG-backed search over its JSON HTTP API. The adapter maps SearXNG's
 * result snippets into the provider-neutral `ctx.web` vocabulary and performs
 * runtime validation at the JSON response boundary.
 *
 * @module @deepseek-ai/dsh-web-search-searxng/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { SearxngError, SearxngResult, SearxngSearchResponse } from './types.ts'

/** Stable id this provider registers under. */
export const SEARXNG_PROVIDER_ID = 'searxng'

/** Environment variable used for the SearXNG instance base URL. */
export const SEARXNG_BASE_URL_ENV = 'SEARXNG_BASE_URL'

/** Attribution header sent on every request. */
const USER_AGENT = 'deepseek-harness/0.1.2-alpha.1'

/** Resolved provider options supplied by the plugin's environment/config step. */
export interface SearxngSearchProviderOptions {
  /** SearXNG instance base URL; `/search` and `format=json` are appended. */
  baseURL: string
}

/**
 * Map one SearXNG result to a normalized source.
 *
 * @param result - one entry of SearXNG's `results[]` response field.
 * @returns the normalized source, or `undefined` when its URL is blank.
 */
export function mapSearxngResult(result: SearxngResult): WebSearchSource | undefined {
  const url = result.url.trim()
  if (url.length === 0) return undefined
  const title = cleanOptional(result.title)
  const snippet = cleanOptional(result.content)
  const publishedAt = cleanOptional(result.publishedDate)
  return {
    url,
    ...title === undefined ? {} : { title },
    ...snippet === undefined ? {} : { snippet },
    ...publishedAt === undefined ? {} : { publishedAt },
  }
}

/**
 * Map a validated SearXNG response to the normalized web result.
 *
 * @param response - the validated SearXNG JSON response.
 * @returns the normalized result; the shared web service owns final truncation.
 */
export function mapSearxngResponse(response: SearxngSearchResponse): WebSearchResult {
  const sources = response.results
    .map(mapSearxngResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  return { sources, truncated: false }
}

/**
 * Validate and decode the fields this adapter consumes from a SearXNG JSON
 * response. Unknown fields remain provider-private and are ignored.
 *
 * @param payload - decoded JSON from SearXNG.
 * @returns the validated response fields used by the adapter.
 * @throws TypeError when the response or a consumed field has the wrong type.
 */
export function parseSearxngResponse(payload: unknown): SearxngSearchResponse {
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    throw new TypeError('SearXNG response.results must be an array')
  }
  return { results: payload.results.map((value, index) => parseSearxngResult(value, index)) }
}

/** The SearXNG-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class SearxngSearchProvider implements WebSearchProvider {
  readonly id = SEARXNG_PROVIDER_ID

  constructor(private readonly options: SearxngSearchProviderOptions) {}

  available(): boolean {
    return parseBaseURL(this.options.baseURL) !== undefined
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    let response: Response
    try {
      response = await fetch(buildSearchURL(this.options.baseURL, request.query), {
        method: 'GET',
        redirect: 'error',
        headers: {
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`SearXNG search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const message = await readErrorMessage(response)
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      return mapSearxngResponse(parseSearxngResponse(await response.json() as unknown))
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`SearXNG returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

/** Return an absolute HTTP(S) base URL without credentials or query state. */
function parseBaseURL(baseURL: string): URL | undefined {
  if (!URL.canParse(baseURL)) return undefined
  const parsed = new URL(baseURL)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  if (parsed.username.length > 0 || parsed.password.length > 0) return undefined
  if (parsed.search.length > 0 || parsed.hash.length > 0) return undefined
  parsed.pathname = parsed.pathname.replace(/\/+$/u, '')
  return parsed
}

/** Build the SearXNG JSON endpoint while preserving an optional deployment path. */
function buildSearchURL(baseURL: string, query: string): string {
  const base = parseBaseURL(baseURL)
  if (base === undefined) throw new TypeError('SearXNG baseURL must be an absolute HTTP(S) URL without credentials, query, or hash')
  const endpoint = new URL(base.href)
  const basePath = base.pathname === '/' ? '' : base.pathname.replace(/\/+$/u, '')
  endpoint.pathname = `${basePath}/search`
  endpoint.searchParams.set('q', query)
  endpoint.searchParams.set('format', 'json')
  return endpoint.href
}

/** Decode a SearXNG result while rejecting fields used by the normalized mapper with wrong types. */
function parseSearxngResult(value: unknown, index: number): SearxngResult {
  if (!isRecord(value)) throw new TypeError(`SearXNG response.results[${index}] must be an object`)
  if (typeof value.url !== 'string') throw new TypeError(`SearXNG response.results[${index}].url must be a string`)
  const title = optionalString(value.title, `results[${index}].title`)
  const content = optionalString(value.content, `results[${index}].content`)
  const publishedDate = optionalString(value.publishedDate, `results[${index}].publishedDate`)
  return {
    url: value.url,
    ...title === undefined ? {} : { title },
    ...content === undefined ? {} : { content },
    ...publishedDate === undefined ? {} : { publishedDate },
  }
}

/** Read an optional nullable string and identify malformed provider JSON. */
function optionalString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') throw new TypeError(`SearXNG response.${field} must be a string or null`)
  return value
}

/** Return a trimmed optional field without inventing data for blank values. */
function cleanOptional(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** Read a useful SearXNG error detail, retaining an HTTP status fallback. */
async function readErrorMessage(response: Response): Promise<string> {
  const fallback = `SearXNG API error (HTTP ${response.status})`
  try {
    const parsed = await response.json() as unknown
    if (!isRecord(parsed)) return fallback
    const error = parsed as SearxngError
    const detail = typeof error.error === 'string' ? error.error : error.message
    return detail !== undefined && detail.trim().length > 0 ? detail : fallback
  } catch (error: unknown) {
    if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
    return fallback
  }
}

/** Narrow decoded JSON objects before reading provider fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True for a fetch/AbortSignal abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
