/** Durable research report metadata and call summaries read by the research row. */

/** One complete saved report carried in a settled call's result metadata. */
export interface ResearchArtifact {
  readonly id: string
  readonly markdown: string
  readonly sources: readonly { readonly url: string; readonly title?: string }[]
}

/**
 * Narrow persisted result metadata to a complete report.
 * @param meta - unvalidated `meta` of a settled research call.
 * @returns the report, or null when the metadata is missing or malformed.
 */
export function researchArtifact(meta: unknown): ResearchArtifact | null {
  if (!meta || typeof meta !== 'object' || !('researchArtifact' in meta)) return null
  const value = meta.researchArtifact
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string'
    || !('markdown' in value) || typeof value.markdown !== 'string'
    || !('sources' in value) || !Array.isArray(value.sources)) return null
  const sources: { url: string; title?: string }[] = []
  for (const item of value.sources as unknown[]) {
    if (!item || typeof item !== 'object' || !('url' in item) || typeof item.url !== 'string') return null
    if ('title' in item && item.title !== undefined && typeof item.title !== 'string') return null
    sources.push({ url: item.url, ...'title' in item && typeof item.title === 'string' ? { title: item.title } : {} })
  }
  return { id: value.id, markdown: value.markdown, sources }
}

/**
 * Keep only navigable web links for saved sources.
 * @param url - source URL recorded by the research worker.
 * @returns the normalized http(s) URL, or undefined for other schemes and malformed text.
 */
export function sourceHref(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : undefined
  } catch {
    // A malformed saved source stays visible as text without a navigable link.
    return undefined
  }
}

/**
 * Pick the most specific readable argument of a research call.
 * @param raw - recorded argument JSON, possibly partial while streaming.
 * @returns the query, run id, or action; empty when none is readable.
 */
export function callSummary(raw: string): string {
  let args: unknown
  try { args = JSON.parse(raw) }
  catch { return '' } // Partial streaming JSON has no complete field yet.
  if (typeof args !== 'object' || args === null) return ''
  for (const field of ['query', 'id', 'action']) {
    const value: unknown = (args as Record<string, unknown>)[field]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

/**
 * Compose the downloadable Markdown document: the report followed by a numbered source list.
 * @param artifact - complete saved report.
 * @param sourcesHeading - localized heading for the source list.
 * @returns the Markdown text offered for download.
 */
export function reportDocument(artifact: ResearchArtifact, sourcesHeading: string): string {
  const sources = artifact.sources.map((source, index) => `${index + 1}. ${source.title ?? source.url}\n   ${source.url}`).join('\n')
  return `${artifact.markdown}\n\n${sourcesHeading}\n\n${sources}\n`
}
