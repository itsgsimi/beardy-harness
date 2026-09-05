/**
 * Splitting of one outbound message body across Discord's per-message length limit.
 * @module @deepseek-ai/dsh-tool-discord/chunk
 */

/**
 * Discord's per-message content limit, counted in UTF-16 code units.
 *
 * The count is the stricter of the two readings of "characters": an astral character such as an
 * emoji occupies two units here and one code point, so a chunk built against this measure is never
 * rejected for length. It is a published protocol limit, not a deployment tunable.
 */
export const DISCORD_MAX_CONTENT_CHARS = 2000

/** A token with the whitespace run that followed it; the finest boundary before a hard cut. */
const TOKEN_PATTERN = /\S+\s*/g

/** Require a chunk limit that can hold text and keep a surrogate pair intact when slicing. */
function assertChunkLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 2) {
    throw new RangeError(`discord content chunk limit must be an integer of at least 2, got ${limit}`)
  }
}

/**
 * Cut a string into pieces of at most `limit` UTF-16 units.
 *
 * A cut that would leave half of a surrogate pair at a piece boundary backs off by one unit, so no
 * piece carries a lone surrogate.
 *
 * @param value - text with no whitespace structure left to preserve.
 * @param limit - maximum UTF-16 units per piece, at least 2.
 * @returns every piece in source order; the last may be shorter.
 */
export function sliceUnits(value: string, limit: number): string[] {
  assertChunkLimit(limit)
  const pieces: string[] = []
  let rest = value
  while (rest.length > limit) {
    let cut = limit
    const lead = rest.charCodeAt(cut - 1)
    if (lead >= 0xd800 && lead <= 0xdbff) cut -= 1
    pieces.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest !== '') pieces.push(rest)
  return pieces
}

/**
 * Greedily pack segments into chunks joined by `separator`.
 *
 * @param segments - every segment already within the limit.
 * @param separator - the source text that joins two segments; dropped at a chunk join.
 * @param limit - maximum UTF-16 units per chunk.
 * @returns the chunks in source order, empty segments aside.
 */
function packSegments(segments: readonly string[], separator: string, limit: number): string[] {
  const chunks: string[] = []
  let current = ''
  for (const segment of segments) {
    if (current === '') {
      current = segment
      continue
    }
    const candidate = current + separator + segment
    if (candidate.length <= limit) {
      current = candidate
      continue
    }
    chunks.push(current)
    current = segment
  }
  if (current !== '') chunks.push(current)
  return chunks
}

/**
 * Pack one line that exceeds the limit, cutting between tokens.
 *
 * Each token carries its own trailing whitespace run, so interior spacing survives exactly; only
 * the run that falls at a chunk join is dropped. A token longer than the limit is cut by
 * {@link sliceUnits}.
 *
 * @param line - text with no paragraph or line breaks left to exploit.
 * @param limit - maximum UTF-16 units per chunk.
 * @returns the chunks in source order.
 */
function packTokens(line: string, limit: number): string[] {
  const chunks: string[] = []
  let current = ''
  let separator = ''
  for (const match of line.matchAll(TOKEN_PATTERN)) {
    const text = match[0].replace(/\s+$/, '')
    const trailing = match[0].slice(text.length)
    const units = text.length <= limit ? [text] : sliceUnits(text, limit)
    units.forEach((unit, index) => {
      const unitSeparator = index === units.length - 1 ? trailing : ''
      if (current === '') {
        current = unit
        separator = unitSeparator
        return
      }
      const candidate = current + separator + unit
      if (candidate.length <= limit) {
        current = candidate
        separator = unitSeparator
        return
      }
      chunks.push(current)
      current = unit
      separator = unitSeparator
    })
  }
  if (current !== '') chunks.push(current)
  return chunks
}

/** Pack one over-long block, exploiting line breaks before cutting between tokens. */
function packBlock(block: string, limit: number): string[] {
  const lines: string[] = []
  for (const line of block.split('\n')) {
    lines.push(...(line.length <= limit ? [line] : packTokens(line, limit)))
  }
  return packSegments(lines, '\n', limit)
}

/**
 * Split a message body into chunks that each satisfy {@link DISCORD_MAX_CONTENT_CHARS}.
 *
 * Packing prefers the coarsest boundary it can: whole paragraphs while they fit, then lines within
 * one over-long block, then tokens, and only a token longer than the limit is cut mid-word. The
 * whitespace at a join is dropped — it would otherwise be the first or last character of a message.
 * Lengths are measured on the `content` value Discord counts, so any wrapper text must already be
 * part of `content`.
 *
 * @param content - the complete body to deliver; leading whitespace is not preserved.
 * @param limit - per-chunk UTF-16 unit cap; defaults to the Discord protocol limit.
 * @returns every chunk in order, or an empty array when `content` holds no text.
 */
export function chunkContent(content: string, limit: number = DISCORD_MAX_CONTENT_CHARS): string[] {
  assertChunkLimit(limit)
  const blocks: string[] = []
  for (const paragraph of content.split('\n\n')) {
    // A paragraph with no text carries nothing a message could show.
    if (paragraph.trim() === '') continue
    blocks.push(...(paragraph.length <= limit ? [paragraph] : packBlock(paragraph, limit)))
  }
  return packSegments(blocks, '\n\n', limit)
}
