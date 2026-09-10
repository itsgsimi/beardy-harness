/**
 * Splitting of one outbound message body across Discord's per-message length limit.
 * @module @deepseek-ai/dsh-tool-discord/chunk
 */

import { discordCodeBlocks, formatDiscordMarkdown } from './markdown.ts'

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

/** Pack prose at paragraph, line, or word boundaries, omitting whitespace at message joins. */
function chunkPlainContent(content: string, limit: number): string[] {
  const blocks: string[] = []
  for (const paragraph of content.split('\n\n')) {
    // A paragraph with no text carries nothing a message could show.
    if (paragraph.trim() === '') continue
    blocks.push(...(paragraph.length <= limit ? [paragraph] : packBlock(paragraph, limit)))
  }
  return packSegments(blocks, '\n\n', limit)
}

/** Split a parsed fenced block with space for the complete opening and closing fences. */
function chunkCode(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const firstBreak = text.indexOf('\n')
  const opening = firstBreak < 0 ? text + '\n' : text.slice(0, firstBreak + 1)
  const marker = /^(`{3,}|~{3,})/.exec(opening)?.[0]
  if (marker === undefined) return sliceUnits(text, limit)
  const lastBreak = text.lastIndexOf('\n')
  const closing = text.slice(lastBreak + 1).trim()
  const isClosed = closing.length >= marker.length && closing.split(marker.charAt(0)).every(part => part === '')
  let remaining = text.slice(firstBreak + 1, isClosed ? lastBreak + 1 : undefined)
  const budget = limit - opening.length - marker.length - 1
  if (budget < 2) throw new RangeError('discord content chunk limit cannot hold the code fence and its language')
  const result: string[] = []
  while (remaining !== '') {
    let cut = Math.min(remaining.length, budget)
    if (cut < remaining.length) {
      const lineBreak = remaining.lastIndexOf('\n', cut - 1)
      if (lineBreak >= 0) cut = lineBreak + 1
      else if (/^[\uDC00-\uDFFF]$/.test(remaining.charAt(cut))) cut -= 1
    }
    const piece = remaining.slice(0, cut)
    remaining = remaining.slice(cut)
    result.push(opening + piece + (piece.endsWith('\n') ? '' : '\n') + marker)
  }
  return result
}

/**
 * Format and split Markdown into Discord messages, counting UTF-16 units including code fences.
 *
 * Tables become labeled bullet groups. Prose splits at paragraphs, lines, or words; whitespace at
 * prose joins is omitted. Split fenced code preserves its language, indentation, and source newlines
 * and closes each message's fence. A custom limit too small for its fence and text is rejected.
 *
 * @param content - complete model-authored Markdown.
 * @param limit - per-message UTF-16 cap, including every added fence; defaults to 2000.
 * @returns ordered messages, or no messages for whitespace-only content.
 * @throws RangeError when the limit cannot hold text or the required code wrapper.
 */
export function chunkContent(content: string, limit: number = DISCORD_MAX_CONTENT_CHARS): string[] {
  assertChunkLimit(limit)
  const formatted = formatDiscordMarkdown(content)
  if (formatted.trim() === '') return []
  if (formatted.length <= limit) return [formatted]
  const chunks: string[] = []
  let offset = 0
  for (const code of discordCodeBlocks(formatted)) {
    chunks.push(...chunkPlainContent(formatted.slice(offset, code.start), limit), ...chunkCode(code.text, limit))
    offset = code.end
  }
  chunks.push(...chunkPlainContent(formatted.slice(offset), limit))
  return chunks
}
