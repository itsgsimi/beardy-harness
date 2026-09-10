/**
 * Pure document model for the two curated memory files: parse, serialize, entry
 * validation, single-entry operations, and cap arithmetic. No IO; the tool layer
 * owns filesystem reads, writes, and approvals.
 * @module @deepseek-ai/dsh-tool-memory/store
 */

/** Which memory file one operation targets. */
export type MemoryTarget = 'user' | 'memory'

/** File name each target writes through. */
export const MEMORY_FILE_NAMES: Record<MemoryTarget, string> = {
  user: 'USER.md',
  memory: 'MEMORY.md',
}

/** One memory operation. `content` is required by add and replace; `old_text` by replace and remove. */
export interface MemoryOperation {
  /** The action to perform on the entry list. */
  readonly action: 'add' | 'replace' | 'remove'
  /** New entry text, without the bullet prefix (add, replace). */
  readonly content?: string
  /** Substring matching exactly one existing entry (replace, remove). */
  readonly old_text?: string
}

/** Rejects file text that is not a strict memory document. Names the offending line. */
export class MemoryDriftError extends Error {
  /** @param message - model-facing explanation naming the file and first bad line. */
  constructor(message: string) {
    super(message)
    this.name = 'MemoryDriftError'
  }
}

/** Control characters a stored entry may not contain; newline is included because entries are one line. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/

/**
 * Parse memory file text into entries. Empty text yields no entries; every other line must be a `- ` bullet.
 * @param text - complete memory file contents.
 * @param fileName - file name used in drift diagnostics.
 * @returns validated entry text without bullet prefixes.
 */
export function parseEntries(text: string, fileName: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const entries: string[] = []
  for (const [index, line] of lines.entries()) {
    if (!line.startsWith('- ') || line.length === 2 || CONTROL_CHARS.test(line)) {
      throw new MemoryDriftError(
        `${fileName} does not match the memory format: line ${String(index + 1)} is not a "- <entry>" bullet. `
        + 'Fix the file by hand or restore it before writing memory.',
      )
    }
    entries.push(line.slice(2))
  }
  return entries
}

/**
 * Serialize entries back to file text: one `- ` bullet per line, exactly one trailing newline.
 * @param entries - validated entry text without bullet prefixes.
 * @returns complete memory file contents.
 */
export function serializeEntries(entries: readonly string[]): string {
  if (entries.length === 0) return ''
  return entries.map(entry => `- ${entry}\n`).join('')
}

/**
 * Validate and normalize one new entry text against the entry cap and the flat format.
 * @param content - model-supplied entry text.
 * @param entryMaxChars - maximum normalized entry length.
 * @returns normalized entry text.
 */
export function validateEntry(content: string, entryMaxChars: number): string {
  const entry = content.trim()
  if (entry.length === 0) throw new Error('memory entry is empty after trimming whitespace')
  if (CONTROL_CHARS.test(entry)) {
    throw new Error('memory entries are single lines: remove newlines and control characters')
  }
  if (entry.startsWith('#')) {
    throw new Error('memory entries are facts, not headings: drop the leading "#" and write the fact itself')
  }
  if (entry.includes('```')) {
    throw new Error('memory entries are prose facts, not code fences: keep code out of memory')
  }
  if (entry.length > entryMaxChars) {
    throw new Error(
      `memory entry is ${String(entry.length)} characters, over the ${String(entryMaxChars)}-character `
      + 'entry cap; shorten it to one declarative fact',
    )
  }
  return entry
}

/**
 * Find the single entry matching `old_text`; zero or multiple matches are model-actionable errors.
 * @param entries - current validated entries.
 * @param oldText - substring that must identify one entry.
 * @param action - operation name used in diagnostics.
 * @returns the unique matching entry index.
 */
export function findEntry(entries: readonly string[], oldText: string, action: string): number {
  const needle = oldText.trim()
  if (needle.length === 0) throw new Error(`memory ${action} requires a non-empty old_text`)
  let matches = 0
  let foundIndex = -1
  for (const [index, entry] of entries.entries()) {
    if (!entry.includes(needle)) continue
    matches += 1
    foundIndex = index
  }
  if (matches === 0) {
    throw new Error(
      `memory ${action}: no entry contains "${needle}". Read the current entries before targeting one.`,
    )
  }
  if (matches > 1) {
    throw new Error(
      `memory ${action}: old_text matches ${String(matches)} entries; `
      + 'extend it until it names exactly one',
    )
  }
  return foundIndex
}

/**
 * Apply one operation to the entry list, returning the new list. Throws on any rejection the model can act on.
 * @param entries - current validated entries.
 * @param operation - requested add, replace, or remove operation.
 * @param entryMaxChars - maximum normalized entry length.
 * @returns the updated entry list.
 */
export function applyOperation(
  entries: readonly string[],
  operation: MemoryOperation,
  entryMaxChars: number,
): string[] {
  if (operation.action === 'add') {
    if (operation.content === undefined) throw new Error('memory add requires content')
    return [...entries, validateEntry(operation.content, entryMaxChars)]
  }
  if (operation.old_text === undefined) {
    throw new Error(`memory ${operation.action} requires old_text`)
  }
  const index = findEntry(entries, operation.old_text, operation.action)
  if (operation.action === 'remove') return entries.filter((_, at) => at !== index)
  if (operation.content === undefined) throw new Error('memory replace requires content')
  const replacement = validateEntry(operation.content, entryMaxChars)
  return entries.map((entry, at) => (at === index ? replacement : entry))
}

/**
 * Reject a serialized document over the target cap, naming the overage and the way out.
 * @param serialized - complete candidate file contents.
 * @param limit - maximum file length in characters.
 * @param fileName - file name used in the rejection message.
 */
export function assertWithinCap(serialized: string, limit: number, fileName: string): void {
  if (serialized.length <= limit) return
  throw new Error(
    `${fileName} would be ${String(serialized.length)} characters, over its ${String(limit)}-character `
    + 'cap. Use action replace to merge or retire an existing entry, then retry.',
  )
}
