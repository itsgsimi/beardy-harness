/**
 * Parsing and validation of model stage answers. Each validator keeps every valid item of an answer and
 * names what it dropped, so one bad item never discards the rest.
 * @module @deepseek-ai/dsh-fantasy-reports/answers
 */

import { CALLS, type CallChoice } from './facts.ts'

const URL_PATTERN = /https?:\/\//iu

/**
 * Extract the JSON object a stage returned, tolerating code fences and surrounding prose. Failures
 * throw fixed messages: the parser's own message quotes the stage output, which must not reach a
 * run's failure reason.
 * @param text - stage output.
 * @returns the parsed object.
 */
export function parseJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('the response contains no JSON object')
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    throw new Error('the response JSON object does not parse')
  }
}

/**
 * Stage JSON check: whether an answer holds one JSON object. Item validation happens after the stage,
 * so a corrective turn is spent only on answers that are not JSON at all.
 * @param text - stage output.
 * @returns true when {@link parseJsonObject} accepts the answer.
 */
export function holdsJsonObject(text: string): boolean {
  try {
    parseJsonObject(text)
  } catch {
    return false
  }
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Bounded prose without URLs.
 * @param value - answer field.
 * @param max - largest length after trimming.
 * @returns trimmed text, or undefined when the field is not 1 to `max` characters of URL-free text.
 */
export function prose(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim().replace(/\s+/gu, ' ')
  return text.length >= 1 && text.length <= max && !URL_PATTERN.test(text) ? text : undefined
}

/** Cited source ids: integers or digit strings, each from the shown set; an absent list cites nothing. */
function citations(value: unknown, shown: ReadonlySet<number>): number[] | string {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return 'sources must be an array'
  const ids: number[] = []
  for (const item of value as unknown[]) {
    const id = typeof item === 'string' && /^\s*[0-9]+\s*$/u.test(item) ? Number(item) : item
    if (typeof id !== 'number' || !shown.has(id)) return `source ${String(item)} was not shown for it`
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

/** One valid model call for a player. */
export interface ModelCall {
  readonly call: CallChoice
  readonly reason: string
  readonly sources: readonly number[]
}

/** Valid calls and the reasons the other requested players have none. */
export interface CallAnswers {
  readonly valid: ReadonlyMap<string, ModelCall>
  readonly invalid: ReadonlyMap<string, string>
}

/** Longest model reason for one player. */
export const REASON_CHARS = 200

/**
 * Validate a per-player call answer against the players it was asked about. A requested id that is
 * missing, has an unknown call, an empty, overlong, or URL-bearing reason, or cites a source not shown
 * for that player is invalid; ids that were not requested are ignored. Keys match case-insensitively.
 * @param text - stage output.
 * @param shown - requested ids, each with the source ids shown for it.
 * @returns valid calls and invalid ids with their reasons; an unparseable answer makes every id invalid.
 */
export function parseCalls(text: string, shown: ReadonlyMap<string, ReadonlySet<number>>): CallAnswers {
  const valid = new Map<string, ModelCall>()
  const invalid = new Map<string, string>()
  let answer: Record<string, unknown>
  try {
    answer = parseJsonObject(text)
  } catch (error) {
    for (const id of shown.keys()) invalid.set(id, (error as Error).message)
    return { valid, invalid }
  }
  const byId = new Map(Object.entries(answer).map(([key, value]) => [key.trim().toUpperCase(), value]))
  for (const [id, sources] of shown) {
    const value = byId.get(id)
    if (!isRecord(value)) {
      invalid.set(id, value === undefined ? 'missing' : 'not an object')
      continue
    }
    const call = typeof value.call === 'string' ? value.call.trim().toUpperCase() : ''
    const reason = prose(value.reason, REASON_CHARS)
    const cited = citations(value.sources, sources)
    if (!(CALLS as readonly string[]).includes(call)) invalid.set(id, 'call must be START, SIT, FLEX, or HOLD')
    else if (reason === undefined) invalid.set(id, `reason must be 1 to ${REASON_CHARS} characters without URLs`)
    else if (typeof cited === 'string') invalid.set(id, cited)
    else valid.set(id, { call: call as CallChoice, reason, sources: cited })
  }
  return { valid, invalid }
}

/** One valid close-call comparison. */
export interface Comparison {
  readonly text: string
  readonly sources: readonly number[]
}

/** Longest close-call comparison. */
export const COMPARISON_CHARS = 600

/**
 * Validate a close-call answer. A pair missing, malformed, overlong, or citing an unshown source is omitted.
 * @param text - stage output.
 * @param shown - pair ids, each with the source ids shown for its two players.
 * @returns valid comparisons by pair id.
 */
export function parseComparisons(text: string, shown: ReadonlyMap<string, ReadonlySet<number>>): Map<string, Comparison> {
  const answer = parseJsonObject(text)
  const byId = new Map(Object.entries(answer).map(([key, value]) => [key.trim().toUpperCase(), value]))
  const valid = new Map<string, Comparison>()
  for (const [id, sources] of shown) {
    const value = byId.get(id)
    if (!isRecord(value)) continue
    const comparison = prose(value.text, COMPARISON_CHARS)
    const cited = citations(value.sources, sources)
    if (comparison !== undefined && typeof cited !== 'string') valid.set(id, { text: comparison, sources: cited })
  }
  return valid
}

/** One valid waiver pick. */
export interface WaiverPick {
  readonly id: string
  readonly reason: string
}

/**
 * Validate a waiver answer: picks with a shortlisted id and a bounded reason, first occurrence only, up to the limit.
 * @param text - stage output.
 * @param ids - shortlisted candidate ids.
 * @param limit - most picks kept.
 * @returns valid picks in answer order.
 */
export function parseWaivers(text: string, ids: ReadonlySet<string>, limit: number): WaiverPick[] {
  const answer = parseJsonObject(text)
  if (!Array.isArray(answer.picks)) throw new Error('picks must be an array')
  const picks: WaiverPick[] = []
  for (const item of answer.picks) {
    if (!isRecord(item) || typeof item.id !== 'string') continue
    const id = item.id.trim().toUpperCase()
    const reason = prose(item.reason, REASON_CHARS)
    if (ids.has(id) && reason !== undefined && !picks.some(pick => pick.id === id)) picks.push({ id, reason })
  }
  return picks.slice(0, limit)
}

/** Longest summary. */
export const SUMMARY_CHARS = 900

/**
 * Validate a summary answer by length only.
 * @param text - stage output.
 * @returns the summary text.
 */
export function parseSummary(text: string): string {
  const summary = prose(parseJsonObject(text).summary, SUMMARY_CHARS)
  if (summary === undefined || summary.length < 40) throw new Error(`summary must be 40 to ${SUMMARY_CHARS} characters without URLs`)
  return summary
}

/**
 * Validate a reason-check answer.
 * @param text - stage output.
 * @param ids - checked roster ids.
 * @returns checked ids the answer flags as unsupported; unknown ids are ignored.
 */
export function parseCheck(text: string, ids: ReadonlySet<string>): Set<string> {
  const answer = parseJsonObject(text)
  if (!Array.isArray(answer.unsupported)) throw new Error('unsupported must be an array')
  return new Set(answer.unsupported.flatMap(item => typeof item === 'string' && ids.has(item.trim().toUpperCase())
    ? [item.trim().toUpperCase()] : []))
}
