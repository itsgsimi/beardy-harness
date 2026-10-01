/** Structured drafts: parsing, code checks, repair patches, and anchored review findings. @module @deepseek-ai/dsh-fantasy-reports/draft */

import type { FantasyPlayer, FantasyRosterSlot } from '@deepseek-ai/dsh-fantasy/types'
import { lineupErrors, type LineupAssignment } from './lineup.ts'
import { admitsPlayer, normalizedText } from './sources.ts'

/** Recommendation for one roster player; SIT means bench this week. */
export type Recommendation = 'START' | 'SIT' | 'CONDITIONAL' | 'HOLD'

/** One sourced observation; the quote is an exact excerpt of its source. */
export interface DraftFact {
  readonly text: string
  readonly source: number
  readonly quote: string
}

/** One roster player's assessment. */
export interface DraftPlayer {
  readonly player: string
  readonly recommendation: Recommendation
  readonly confidence: 'high' | 'medium' | 'low'
  readonly facts: readonly DraftFact[]
  readonly reason: string
  readonly watch: string
}

/** One close start/sit comparison. */
export interface DraftDecision {
  readonly title: string
  readonly text: string
  readonly sources: readonly number[]
}

/** A complete structured report before rendering. */
export interface FantasyDraft {
  readonly players: readonly DraftPlayer[]
  readonly lineup: readonly LineupAssignment[]
  readonly actions: readonly string[]
  readonly decisions: readonly DraftDecision[]
  readonly caveats: readonly string[]
}

/** One admitted page as the models see it. */
export interface Evidence {
  /** Citation number. */
  readonly id: number
  readonly url: string
  readonly title: string
  /** Short roster ids the page was admitted for. */
  readonly players: readonly string[]
  /** Exact model-visible text; quotes must be excerpts of it. */
  readonly text: string
}

/** Roster facts a draft is checked against. */
export interface DraftContext {
  /** Roster players by short id, in roster order. */
  readonly players: ReadonlyMap<string, FantasyPlayer>
  readonly slots: readonly FantasyRosterSlot[]
  readonly week: number
  readonly evidence: readonly Evidence[]
}

const RECOMMENDATIONS = new Set<Recommendation>(['START', 'SIT', 'CONDITIONAL', 'HOLD'])
const RECOMMENDATION_ALIASES: Readonly<Record<string, Recommendation>> = {
  BENCH: 'SIT', BENCHED: 'SIT', 'SIT/BENCH': 'SIT', 'BENCH/SIT': 'SIT', 'BENCH/HOLD': 'HOLD', 'HOLD/BENCH': 'HOLD',
  STARTER: 'START', FLEX: 'START', 'CONDITIONAL START': 'CONDITIONAL', 'START (CONDITIONAL)': 'CONDITIONAL',
  'START IF ACTIVE': 'CONDITIONAL',
}
const CONFIDENCES = new Set(['high', 'medium', 'low'])
const URL_PATTERN = /https?:\/\//iu

/**
 * Extract the JSON object a stage returned, tolerating code fences and surrounding prose.
 * @param text - stage output.
 * @returns the parsed object.
 */
export function parseJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('the response contains no JSON object')
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new Error(`${where} must be a string`)
  return value.trim()
}

function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array`)
  return value
}

function parsePlayer(value: unknown, index: number): DraftPlayer {
  if (!isRecord(value)) throw new Error(`players[${index}] must be an object`)
  const player = text(value.player, `players[${index}].player`)
  const raw = text(value.recommendation, `${player}.recommendation`).toUpperCase().replace(/\s+/gu, ' ')
  const recommendation = RECOMMENDATIONS.has(raw as Recommendation) ? raw as Recommendation : RECOMMENDATION_ALIASES[raw]
  if (recommendation === undefined) throw new Error(`${player}.recommendation must be START, SIT, CONDITIONAL, or HOLD`)
  const confidence = text(value.confidence, `${player}.confidence`).toLowerCase()
  if (!CONFIDENCES.has(confidence)) throw new Error(`${player}.confidence must be high, medium, or low`)
  const facts = list(value.facts, `${player}.facts`).map((fact, factIndex) => {
    if (!isRecord(fact)) throw new Error(`${player}.facts[${factIndex}] must be an object`)
    const source = typeof fact.source === 'string' && /^[0-9]+$/u.test(fact.source.trim()) ? Number(fact.source) : fact.source
    if (typeof source !== 'number' || !Number.isSafeInteger(source)) throw new Error(`${player}.facts[${factIndex}].source must be an integer`)
    return { text: text(fact.text, `${player}.facts[${factIndex}].text`), source,
      quote: text(fact.quote, `${player}.facts[${factIndex}].quote`) }
  })
  return { player, recommendation, confidence: confidence as DraftPlayer['confidence'], facts,
    reason: text(value.reason, `${player}.reason`), watch: text(value.watch, `${player}.watch`) }
}

function parseLineup(value: unknown): LineupAssignment[] {
  return list(value, 'lineup').map((item, index) => {
    if (!isRecord(item)) throw new Error(`lineup[${index}] must be an object`)
    return { player: text(item.player, `lineup[${index}].player`), slot: text(item.slot, `lineup[${index}].slot`).toUpperCase() }
  })
}

function parseDecisions(value: unknown): DraftDecision[] {
  return list(value, 'decisions').map((item, index) => {
    if (!isRecord(item)) throw new Error(`decisions[${index}] must be an object`)
    const sources = list(item.sources, `decisions[${index}].sources`).map((source) => {
      if (typeof source !== 'number' || !Number.isSafeInteger(source)) throw new Error(`decisions[${index}].sources must be integers`)
      return source
    })
    return { title: text(item.title, `decisions[${index}].title`), text: text(item.text, `decisions[${index}].text`), sources }
  })
}

function strings(value: unknown, where: string): string[] {
  return list(value, where).map((item, index) => text(item, `${where}[${index}]`))
}

/**
 * Parse a complete writer draft without trusting the model's JSON shape.
 * @param output - writer stage text.
 * @returns typed draft; shape errors throw and count as a structural repair.
 */
export function parseDraft(output: string): FantasyDraft {
  const value = parseJsonObject(output)
  return {
    players: list(value.players, 'players').map(parsePlayer), lineup: parseLineup(value.lineup),
    actions: strings(value.actions, 'actions'), decisions: parseDecisions(value.decisions), caveats: strings(value.caveats, 'caveats'),
  }
}

/**
 * Name a patch row by `id` when it has no `player`: repair stages are told to keep each row's id, and
 * some answer `{"id":"P14",...}`. Only patch rows accept the alias; a writer draft must use `player`.
 */
function patchRow(value: unknown): unknown {
  if (!isRecord(value) || value.player !== undefined || typeof value.id !== 'string') return value
  const { id, ...row } = value
  return { ...row, player: id }
}

/**
 * Apply a repair patch: changed player rows replace their originals, and a non-empty section replaces its section.
 * A patch row may name its player with `id` instead of `player`.
 * @param draft - current draft.
 * @param output - repair stage text.
 * @returns the patched draft; a malformed patch throws.
 */
export function applyPatch(draft: FantasyDraft, output: string): FantasyDraft {
  const value = parseJsonObject(output)
  const rows = new Map(list(value.players ?? [], 'players').map(patchRow).map(parsePlayer).map(row => [row.player, row]))
  for (const player of rows.keys()) {
    if (!draft.players.some(row => row.player === player)) throw new Error(`the patch changes unknown player ${player}`)
  }
  const lineup = value.lineup === undefined ? [] : parseLineup(value.lineup)
  const actions = value.actions === undefined ? [] : strings(value.actions, 'actions')
  const decisions = value.decisions === undefined ? [] : parseDecisions(value.decisions)
  const caveats = value.caveats === undefined ? [] : strings(value.caveats, 'caveats')
  return {
    players: draft.players.map(row => rows.get(row.player) ?? row),
    lineup: lineup.length > 0 ? lineup : draft.lineup,
    actions: actions.length > 0 ? actions : draft.actions,
    decisions: decisions.length > 0 ? decisions : draft.decisions,
    caveats: caveats.length > 0 ? caveats : draft.caveats,
  }
}

/** Page navigation that writers copy ahead of the sentence they mean to quote. */
const PAGE_NAVIGATION = /^[\s\S]*\b(?:view more (?:news|notes)|player news|expert notes?|start \/ sit availability)\b\s*/iu

/**
 * Shorten literal but oversized quotes and strip copied page navigation. Only text still found in the
 * cited source survives; everything else is left for the structural check.
 * @param draft - draft to tidy.
 * @param evidence - admitted pages.
 * @returns draft with tidied quotes.
 */
export function trimQuotes(draft: FantasyDraft, evidence: readonly Evidence[]): FantasyDraft {
  const sources = new Map(evidence.map(source => [source.id, normalizedText(source.text)]))
  return {
    ...draft,
    players: draft.players.map(row => ({ ...row, facts: row.facts.map((fact) => {
      const source = sources.get(fact.source)
      let quote = fact.quote.trim().replace(/^["\u201c\u201d'\u2018\u2019\u2026]+|["\u201c\u201d'\u2018\u2019\u2026]+$/gu, '')
      if (source === undefined || !source.includes(normalizedText(quote))) return fact
      const stripped = quote.replace(PAGE_NAVIGATION, '').trim()
      if (stripped.length >= 12 && stripped.length < quote.length && source.includes(normalizedText(stripped))) quote = stripped
      if (quote.length > 300) {
        const cut = quote.slice(0, 300)
        const space = cut.lastIndexOf(' ')
        quote = (space > 100 ? cut.slice(0, space) : cut).trim()
      }
      return { ...fact, quote }
    }) })),
  }
}

function bounded(value: string, min: number, max: number): boolean {
  return value.length >= min && value.length <= max && !URL_PATTERN.test(value)
}

/**
 * Code checks every draft must pass before review or publication: full roster coverage, literal quotes
 * from pages about the same player, a legal Yahoo lineup of available starters, and bounded sections.
 * @param draft - parsed draft.
 * @param context - roster, slots, week, and admitted pages.
 * @returns concrete errors naming the affected player where one applies; empty means structurally valid.
 */
export function draftErrors(draft: FantasyDraft, context: DraftContext): string[] {
  const errors: string[] = []
  const sources = new Map(context.evidence.map(source => [source.id, source]))
  const rows = new Map<string, DraftPlayer>()
  for (const row of draft.players) {
    const player = context.players.get(row.player)
    if (player === undefined) {
      errors.push(`${row.player}: not a roster id`)
      continue
    }
    if (rows.has(row.player)) errors.push(`${row.player}: appears more than once`)
    rows.set(row.player, row)
    if (!bounded(row.reason, 1, 550)) errors.push(`${row.player}: reason must be 1 to 550 characters without URLs`)
    if (!bounded(row.watch, 1, 250)) errors.push(`${row.player}: watch must be 1 to 250 characters without URLs`)
    const hasSources = context.evidence.some(source => source.players.includes(row.player))
    if (row.facts.length > 3 || (hasSources && row.facts.length === 0)) {
      errors.push(`${row.player}: needs 1 to 3 facts from its admitted sources`)
    }
    for (const [index, fact] of row.facts.entries()) {
      const source = sources.get(fact.source)
      if (!bounded(fact.text, 5, 400)) errors.push(`${row.player}: fact ${index} text must be 5 to 400 characters without URLs`)
      if (source === undefined) {
        errors.push(`${row.player}: fact ${index} cites unknown source ${fact.source}`)
      } else if (!source.players.includes(row.player) && !admitsPlayer(player, source.text)) {
        errors.push(`${row.player}: fact ${index} cites source ${fact.source}, which does not name ${player.name}`)
      } else if (fact.quote.length < 12 || fact.quote.length > 300
        || !normalizedText(source.text).includes(normalizedText(fact.quote))) {
        errors.push(`${row.player}: fact ${index} quote is not a 12 to 300 character excerpt of source ${fact.source}`)
      }
    }
  }
  for (const id of context.players.keys()) if (!rows.has(id)) errors.push(`${id}: missing roster row`)
  errors.push(...lineupErrors(draft.lineup, context.players, context.slots, context.week))
  for (const assignment of draft.lineup) {
    const row = rows.get(assignment.player)
    if (row !== undefined && row.recommendation !== 'START' && row.recommendation !== 'CONDITIONAL') {
      errors.push(`${assignment.player}: starts in ${assignment.slot} but is recommended ${row.recommendation}`)
    }
  }
  if (draft.actions.length < 1 || draft.actions.length > 4 || draft.actions.some(item => !bounded(item, 1, 500))) {
    errors.push('actions: needs 1 to 4 entries of at most 500 characters without URLs')
  }
  if (draft.caveats.length < 1 || draft.caveats.length > 5 || draft.caveats.some(item => !bounded(item, 1, 400))) {
    errors.push('caveats: needs 1 to 5 entries of at most 400 characters without URLs')
  }
  if (draft.decisions.length < 1 || draft.decisions.length > 4) errors.push('decisions: needs 1 to 4 comparisons')
  for (const [index, decision] of draft.decisions.entries()) {
    if (!bounded(decision.title, 1, 120) || !bounded(decision.text, 30, 1200)) {
      errors.push(`decisions[${index}]: title needs 1 to 120 and text 30 to 1200 characters without URLs`)
    }
    if (decision.sources.length === 0 || decision.sources.some(source => !sources.has(source))) {
      errors.push(`decisions[${index}]: sources must cite admitted source numbers`)
    }
  }
  return errors
}

/** Reviewer finding kinds; the first two identify wrong protected facts. */
export const REVIEW_KINDS = ['wrong_team_or_schedule', 'stale_season', 'contradicts_source', 'fabricated_or_external_fact',
  'medical_speculation', 'wrong_advice_logic', 'wording_or_precision'] as const

/** One reviewer finding kind. */
export type ReviewKind = typeof REVIEW_KINDS[number]

/** Finding kinds that still withhold publication after the last review. */
const BLOCKING_KINDS = new Set<ReviewKind>(['wrong_team_or_schedule', 'stale_season'])

/** One reviewer finding anchored in the draft and, for contradictions, in supplied text. */
export interface ReviewIssue {
  readonly player: string | null
  readonly kind: ReviewKind
  readonly claim: string
  readonly evidence: string
  readonly problem: string
  readonly fix: string
}

/** Kept and discarded findings of one review. */
export interface FilteredReview {
  readonly issues: readonly ReviewIssue[]
  readonly discarded: readonly { readonly issue: unknown; readonly reason: string }[]
}

const NON_FIXES = new Set(['none', 'no fix', 'no fix needed', 'no fix required', 'no change', 'no change needed',
  'no change required', 'no action', 'no action needed', 'no correction', 'no correction needed', 'not applicable', 'n/a',
  'no issue', 'no issues', 'none needed', 'nothing', 'nothing to fix', 'keep as is', 'keep as-is'])

/**
 * Normalized text of everything a reviewer may quote from a draft.
 * @param draft - draft under review.
 * @returns comparison form of the draft's prose.
 */
export function draftProse(draft: FantasyDraft): string {
  return normalizedText([
    ...draft.players.flatMap(row => [row.reason, row.watch, row.recommendation, row.confidence,
      ...row.facts.flatMap(fact => [fact.text, fact.quote])]),
    ...draft.actions, ...draft.caveats, ...draft.decisions.flatMap(decision => [decision.title, decision.text]),
  ].join(' '))
}

/** Whether every substantive segment of a possibly elided excerpt, or a short excerpt whole, appears in normalized text. */
function anchored(excerpt: string, haystack: string): boolean {
  const segments = excerpt.split(/\.\.\.|\u2026/u).map(normalizedText).filter(segment => segment.length >= 12)
  if (segments.length > 0) return segments.every(segment => haystack.includes(segment))
  const whole = normalizedText(excerpt)
  return whole !== '' && haystack.includes(whole)
}

/**
 * Keep reviewer findings that quote the draft verbatim and, when they cite evidence, quote supplied text
 * verbatim. Wording-only notes, self-declared non-issues, unknown players, and repeats are discarded.
 * @param raw - parsed reviewer object.
 * @param draft - exact draft under review.
 * @param supplied - normalized source and protected-context text shown to the reviewer.
 * @param players - roster ids a finding may name.
 * @returns kept and discarded findings.
 */
export function filterReview(raw: Record<string, unknown>, draft: FantasyDraft, supplied: string,
  players: ReadonlySet<string>): FilteredReview {
  const prose = draftProse(draft)
  const issues: ReviewIssue[] = []
  const discarded: Array<{ issue: unknown; reason: string }> = []
  const seen = new Set<string>()
  for (const issue of list(raw.issues, 'issues')) {
    const reason = rejection(issue, prose, supplied, players)
    if (reason !== undefined) {
      discarded.push({ issue, reason })
      continue
    }
    const kept = issue as Omit<ReviewIssue, 'player' | 'evidence'> & { readonly player?: string | null; readonly evidence?: string }
    const key = `${kept.player ?? ''}\n${normalizedText(kept.claim)}`
    if (seen.has(key)) {
      discarded.push({ issue, reason: 'repeat' })
      continue
    }
    seen.add(key)
    issues.push({ player: kept.player ?? null, kind: kept.kind, claim: kept.claim, evidence: kept.evidence ?? '',
      problem: kept.problem, fix: kept.fix })
  }
  return { issues, discarded }
}

function rejection(issue: unknown, prose: string, supplied: string, players: ReadonlySet<string>): string | undefined {
  if (!isRecord(issue) || typeof issue.claim !== 'string' || typeof issue.problem !== 'string' || typeof issue.fix !== 'string'
    || (issue.evidence !== undefined && typeof issue.evidence !== 'string')) return 'malformed'
  if (!(REVIEW_KINDS as readonly unknown[]).includes(issue.kind)) return 'unknown kind'
  const player = issue.player ?? null
  if (player !== null && (typeof player !== 'string' || !players.has(player))) return 'unknown player'
  if (NON_FIXES.has(issue.fix.trim().toLowerCase().replace(/[\s.!]+$/u, ''))) return 'no fix'
  if (issue.kind === 'wording_or_precision') return 'wording only'
  if (!anchored(issue.claim, prose)) return 'claim not in draft'
  if (typeof issue.evidence === 'string' && issue.evidence.trim() !== '' && !anchored(issue.evidence, supplied)) {
    return 'evidence not in supplied text'
  }
  return undefined
}

/**
 * Whether a finding must withhold publication even after the last review round.
 * @param issue - kept reviewer finding.
 * @returns true for wrong team, schedule, or season findings.
 */
export function blocksPublication(issue: ReviewIssue): boolean {
  return BLOCKING_KINDS.has(issue.kind)
}
