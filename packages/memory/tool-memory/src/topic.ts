/** Topic document validation and retirement without changing the owner's Markdown shape. */

import { createHash } from 'node:crypto'

/** Public slug form for a topic file under `memories/`. */
export const TOPIC_SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/**
 * Stable content version exposed to the model; filesystem versions still guard publication.
 * @param text - complete topic document.
 * @returns content hash used by replace and remove.
 */
export function topicVersion(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

/** Metadata read from a complete topic document. */
export interface TopicMetadata {
  readonly updated: string
  readonly status: 'active' | 'retired'
  readonly source: string
  readonly supersededBy?: string
}

/**
 * Reject traversal and names that cannot round-trip to one flat Markdown file.
 * @param slug - proposed topic name.
 */
export function validateTopicSlug(slug: string): void {
  if (!TOPIC_SLUG.test(slug)) throw new Error('topic must be a lowercase kebab-case slug without path separators')
}

/**
 * Validate the observed frontmatter and ordered Rule, Why, History sections.
 * Preserve the original body and all unrelated frontmatter when writing.
 * @param text - complete topic Markdown.
 * @returns metadata used by list and read.
 */
export function parseTopic(text: string): TopicMetadata {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)
  if (match === null) throw new Error('topic needs YAML frontmatter delimited by --- lines')
  const fields = new Map<string, string>()
  for (const line of match.slice(1, 2).join('').split(/\r?\n/)) {
    const field = /^([a-z][a-z-]*):\s*(.*?)\s*$/.exec(line)
    const key = field?.[1]
    const value = field?.[2]
    if (key === undefined || value === undefined || fields.has(key)) {
      throw new Error('topic frontmatter has an invalid or duplicate field')
    }
    fields.set(key, value.replace(/^['"]|['"]$/g, ''))
  }
  const updated = fields.get('updated')
  const status = fields.get('status')
  const source = fields.get('source')
  const supersededBy = fields.get('superseded-by')
  if (updated === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(updated)
    || (status !== 'active' && status !== 'retired') || source === undefined || source === '') {
    throw new Error('topic frontmatter requires updated (YYYY-MM-DD), status (active or retired), and source')
  }
  if (supersededBy !== undefined && supersededBy !== '') validateTopicSlug(supersededBy)
  const headings = [...text.matchAll(/^## (Rule|Why|History)\s*$/gm)].map(item => item[1])
  if (headings.join(',') !== 'Rule,Why,History') {
    throw new Error('topic must contain ## Rule, ## Why, and ## History sections in that order')
  }
  return { updated, status, source, ...supersededBy ? { supersededBy } : {} }
}

/**
 * Retire one active topic and append a History entry while keeping its existing prose intact.
 * @param text - validated complete topic document.
 * @param date - current date in YYYY-MM-DD form.
 * @param successor - optional replacement topic slug.
 * @returns complete retired document.
 */
export function retireTopic(text: string, date: string, successor?: string): string {
  const metadata = parseTopic(text)
  if (metadata.status !== 'active') throw new Error('topic is already retired')
  if (successor !== undefined) validateTopicSlug(successor)
  let next = text.replace(/^status:[ \t]*.*$/m, 'status: retired').replace(/^updated:[ \t]*.*$/m, `updated: ${date}`)
  if (successor !== undefined) {
    next = /^superseded-by:/m.test(next)
      ? next.replace(/^superseded-by:[ \t]*.*$/m, `superseded-by: ${successor}`)
      : next.replace(/^---\r?\n/, `---\nsuperseded-by: ${successor}\n`)
  }
  return `${next.replace(/\n*$/, '')}\n- Retired ${date}${successor === undefined ? '' : `; superseded by ${successor}`}\n`
}
