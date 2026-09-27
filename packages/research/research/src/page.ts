/** Shared model-facing research response paging. @module @deepseek-ai/dsh-research/page */

/** Complete report metadata retained outside the model text page. */
export interface ResearchPageArtifact {
  readonly id: string
  readonly markdown: string
  readonly sources: readonly { readonly url: string; readonly title?: string }[]
}

/** One JSON response page and optional complete first-page report metadata. */
export interface ResearchPageResponse<Artifact extends ResearchPageArtifact = ResearchPageArtifact> {
  readonly text: string
  readonly artifact?: Artifact
}

/** Shared tool output shape for native and remote research reports. */
export const researchPageOutputSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    text: { type: 'string', required: true },
    artifact: { type: 'object', additionalProperties: false, properties: {
      id: { type: 'string', required: true }, markdown: { type: 'string', required: true },
      sources: { type: 'array', required: true, items: { type: 'object', additionalProperties: false,
        properties: { url: { type: 'string', required: true }, title: { type: 'string' } } } },
    } },
  },
} as const

/** Shared text and viewer projection for a research page result. */
export const researchPageOutput = {
  schema: researchPageOutputSchema,
  render: (_args: unknown, value: ResearchPageResponse) => [{ type: 'text' as const, text: value.text }],
  presentationMeta: (_args: unknown, value: ResearchPageResponse) =>
    value.artifact === undefined ? {} : { researchArtifact: {
      id: value.artifact.id, markdown: value.artifact.markdown,
      sources: value.artifact.sources.map(source => ({ url: source.url,
        ...(source.title === undefined ? {} : { title: source.title }) })),
    } },
}

/**
 * Slice serialized JSON by Unicode code point and include an explicit continuation offset.
 * Callers validate non-negative offsets and positive page bounds before calling.
 * @param value - serializable status, list, or report payload.
 * @param offset - Unicode code point offset into the serialized payload.
 * @param pageChars - maximum Unicode code points in this page.
 * @param artifact - complete report metadata on page zero, if present.
 * @returns JSON page text and optional complete report metadata.
 */
export function paginateResearchResponse<Artifact extends ResearchPageArtifact>(
  value: unknown, offset: number, pageChars: number, artifact?: Artifact,
): ResearchPageResponse<Artifact> {
  const chars = Array.from(JSON.stringify(value))
  if (offset > chars.length) throw new Error('offset exceeds the response length')
  const end = Math.min(offset + pageChars, chars.length)
  return {
    text: JSON.stringify({ text: chars.slice(offset, end).join(''), next_offset: end < chars.length ? end : null,
      total_chars: chars.length }),
    ...(artifact === undefined ? {} : { artifact }),
  }
}
