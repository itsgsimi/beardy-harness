/**
 * Wire types for the SearXNG JSON search API (`GET /search?format=json`).
 * SearXNG returns a flat `results[]`; each entry carries a URL and may carry a
 * title, content snippet, or publication date.
 *
 * @module @deepseek-ai/dsh-web-search-searxng/types
 */

/** One entry of SearXNG's flat `results[]`. */
export interface SearxngResult {
  url: string
  title?: string | null
  content?: string | null
  publishedDate?: string | null
}

/** SearXNG's JSON search response envelope. */
export interface SearxngSearchResponse {
  results: SearxngResult[]
}

/** Best-effort fields from a SearXNG error response. */
export interface SearxngError {
  error?: string
  message?: string
}
