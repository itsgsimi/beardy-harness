/**
 * Outbound text shaping: splitting a delivery into Signal-sized parts and turning paired `**bold**`
 * markers into Signal body-range styles.
 * @module @deepseek-ai/dsh-signal-cli/text
 */

/**
 * Split text into ordered parts of at most `limit` UTF-16 units, preferring a paragraph break,
 * then a line break, then a space in the second half of each part; a surrogate pair is never cut.
 * @param text - complete delivery text.
 * @param limit - longest part.
 * @returns non-empty parts, or none for whitespace-only text.
 */
export function splitText(text: string, limit: number): string[] {
  const parts: string[] = []
  let rest = text.trim()
  while (rest.length > limit) {
    const floor = Math.floor(limit / 2)
    let cut = rest.lastIndexOf('\n\n', limit)
    if (cut < floor) cut = rest.lastIndexOf('\n', limit)
    if (cut < floor) cut = rest.lastIndexOf(' ', limit)
    if (cut < floor) {
      const last = rest.charCodeAt(limit - 1)
      cut = last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit
    }
    parts.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest !== '') parts.push(rest)
  return parts
}

/** One part ready for `send`: its visible text and signal-cli `textStyle` ranges. */
export interface StyledText {
  readonly message: string
  /** `start:length:BOLD` ranges in UTF-16 units of `message`. */
  readonly textStyle: readonly string[]
}

/**
 * Remove each paired `**…**` marker on one line whose enclosed text neither starts nor ends with
 * whitespace, recording that text as a bold range; any other marker stays literal.
 * @param text - one part.
 * @returns visible text and its bold ranges.
 */
export function styleText(text: string): StyledText {
  let message = ''
  const textStyle: string[] = []
  let offset = 0
  for (const match of text.matchAll(/\*\*([^*\s](?:[^\n]*?[^*\s])?)\*\*/gu)) {
    message += text.slice(offset, match.index)
    // The pattern's single capture group always participates in a match.
    const inner = match[1] as string
    textStyle.push(`${String(message.length)}:${String(inner.length)}:BOLD`)
    message += inner
    offset = match.index + match[0].length
  }
  return { message: message + text.slice(offset), textStyle }
}
