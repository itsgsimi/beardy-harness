/** General research pipeline over logged stage Agents and the web seam. */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  ResearchCategory, ResearchFinding, ResearchOwner, ResearchRunId, ResearchSearch, ResearchSource, ResearchSourceAttempt,
} from '@deepseek-ai/dsh-research/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { renderBody } from '@deepseek-ai/dsh-tool-web/conversion'
import type {} from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-attachment'
import type { ResolvedConfig } from './config.ts'
import { datePreamble, extractPrompt, finalPrompt, planPrompt, queryPrompt, stopPrompt, synthesisPrompt } from './prompts.ts'
import { RESEARCH_PROMPT_VERSION, RESEARCH_STAGE_SYSTEM_PROMPT } from './prompts.ts'
import { runStage, type StageAdmission } from './stage.ts'

/** Run Session writes performed through the provider's serialized commit barrier. */
export interface EngineStorage {
  checkpoint(id: ResearchRunId, owner: ResearchOwner, checkpoint: {
    round: number
    elapsedMs: number
    stageSessionId?: SessionId
    queries?: readonly string[]
    urls?: readonly string[]
    stopReason?: string
    draftRef?: FileAttachmentRef
  }): Promise<unknown>
  search(id: ResearchRunId, owner: ResearchOwner, result: ResearchSearch): Promise<void>
  source(id: ResearchRunId, owner: ResearchOwner, result: ResearchSourceAttempt): Promise<void>
  finding(id: ResearchRunId, owner: ResearchOwner, result: ResearchFinding): Promise<void>
  finish(id: ResearchRunId, owner: ResearchOwner, result: {
    phase: 'completed' | 'failed' | 'budget_exhausted' | 'cancelled'
    reason?: string
    markdown?: string
    evidence?: string
    quality?: 'verified_urls' | 'partial' | 'source_unavailable'
  }, signal?: AbortSignal): Promise<unknown>
}

interface Finding {
  readonly source: ResearchSource
  readonly rational: string
  readonly evidence: string
  readonly summary: string
}

/** Parse a model JSON array, accepting fenced output and complete strings in a cut array.
 * @param text - model response to query generation.
 * @param limit - maximum distinct queries to retain.
 * @returns normalized distinct queries in first occurrence order.
 */
export function parseQueries(text: string, limit: number): string[] {
  const candidate = text.replace(/^\s*```(?:json)?\s*/iu, '').replace(/\s*```\s*$/u, '').trim()
  let values: unknown
  try {
    values = JSON.parse(candidate)
  } catch {
    const start = candidate.indexOf('[')
    const end = candidate.lastIndexOf(']')
    if (start >= 0 && end > start) {
      try { values = JSON.parse(candidate.slice(start, end + 1)) } catch { values = [] }
    } else {
      const incomplete = start < 0 ? '' : candidate.slice(start)
      values = [...incomplete.matchAll(/"(?:\\.|[^"\\])*"/gu)].map((match) => {
        try { return JSON.parse(match[0]) as string } catch { return '' }
      })
    }
  }
  if (!Array.isArray(values)) return []
  const seen = new Set<string>()
  return values.filter((value): value is string => typeof value === 'string')
    .map(value => value.trim()).filter((value) => {
      const key = value.toLocaleLowerCase()
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    }).slice(0, limit)
}

/** Parse one extraction object, rejecting malformed or low-value summaries.
 * @param text - model response to page extraction.
 * @returns normalized finding fields, or undefined when unusable.
 */
export function parseFinding(text: string): { rational: string; evidence: string; summary: string } | undefined {
  const candidate = text.replace(/^\s*```(?:json)?\s*/iu, '').replace(/\s*```\s*$/u, '').trim()
  let value: unknown
  try { value = JSON.parse(candidate) } catch { return undefined }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  if (typeof item.rational !== 'string' || typeof item.evidence !== 'string' || typeof item.summary !== 'string') return undefined
  const summary = item.summary.trim()
  if (!summary || !item.evidence.trim() || LOW_QUALITY.some(marker => summary.toLowerCase().includes(marker))) return undefined
  return { rational: item.rational.trim(), evidence: item.evidence.trim(), summary }
}

const LOW_QUALITY = [
  'insufficient to', 'content is insufficient', 'no substantive data', 'does not contain',
  'not relevant to', 'no relevant information', 'unable to extract', 'completely unrelated',
  'boilerplate', 'footer text', 'cookie consent', 'cookie banner', 'cookie notice',
  'copyright notice', 'copyright footer', 'all rights reserved',
]

/** Normalize web URL identity for deduplication and fetched-source checks. */
function normalizedUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    url.hash = ''
    return url.href
  } catch { return undefined }
}

/** Replace unsupported report URLs with labeled text and record the omissions.
 * @param markdown - final report text.
 * @param accepted - normalized URLs of fetched accepted sources.
 * @returns checked report text and omitted URL list.
 */
export function checkCitationUrls(markdown: string, accepted: ReadonlySet<string>): { markdown: string; unsupported: string[] } {
  const unsupported: string[] = []
  const links = markdown.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gu, (match, label: string, url: string) => {
    const normalized = normalizedUrl(url)
    if (normalized !== undefined && accepted.has(normalized)) return match
    unsupported.push(url)
    return `${label} [unverified citation omitted]`
  })
  const cleaned = links.replace(/https?:\/\/[^\s<>)\]]+/gu, (raw) => {
    const punctuation = /[.,;]+$/u.exec(raw)?.[0] ?? ''
    const url = raw.slice(0, raw.length - punctuation.length)
    const normalized = normalizedUrl(url)
    if (normalized !== undefined && accepted.has(normalized)) return raw
    unsupported.push(url)
    return `[unverified citation omitted]${punctuation}`
  })
  return { markdown: unsupported.length === 0 ? cleaned : `${cleaned}\n\n## Citation limitations\n${unsupported.length} unsupported citation URL(s) were omitted.`, unsupported }
}

/** Bounded parallel map that joins dispatched work before propagating a failure.
 * @param items - dense input sequence.
 * @param limit - maximum concurrent operations.
 * @param signal - run cancellation.
 * @param work - one asynchronous search, fetch, or extraction.
 * @returns results in input order after all dispatched operations settle.
 */
export async function mapLimit<T, U>(items: readonly T[], limit: number, signal: AbortSignal,
  work: (item: T) => Promise<U>): Promise<U[]> {
  const values = new Array<U>(items.length)
  let cursor = 0
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      signal.throwIfAborted()
      const index = cursor++
      values[index] = await work(items[index] as T)
      signal.throwIfAborted()
    }
  }))
  const failure = outcomes.find(outcome => outcome.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
  return values
}

/** General provider engine; its model stages share the provider's admission gate with workflow runs. */
export class ResearchEngine {
  /**
   * @param ctx - provider context with web, model and attachment services.
   * @param config - resolved route and budgets.
   * @param storage - durable event writer.
   * @param admission - provider-wide model stage gate.
   */
  constructor(private readonly ctx: Context, private readonly config: ResolvedConfig, private readonly storage: EngineStorage,
    private readonly admission: StageAdmission) {}

  /**
   * Execute a committed run until a terminal event or cancellation.
   * @param id - durable run identity.
   * @param parentAgent - live run Agent that owns stage Agent scopes.
   * @param owner - authority recorded in the run.
   * @param question - trimmed question recorded in the run.
   * @param category - provider-side report format.
   * @param signal - owner cancellation or hard timeout.
   * @param startedAt - launch time for elapsed and soft budget checks.
   * @param contextWindow - known model context ceiling, if its adapter exposes one.
   * @param cwd - caller workspace retained in the run and stage Session headers.
   */
  async run(id: ResearchRunId, parentAgent: Agent, owner: ResearchOwner, question: string, category: ResearchCategory,
    signal: AbortSignal, startedAt: number, contextWindow?: number, cwd?: string): Promise<void> {
    const budgets = this.config.budgets
    const date = datePreamble(new Date(startedAt))
    const seenQueries = new Set<string>()
    const seenUrls = new Set<string>()
    const sources: ResearchSource[] = []
    const accepted: Finding[] = []
    const stage = async (prompt: string, maxTokens: number, round: number): Promise<string> => {
      signal.throwIfAborted()
      if (contextWindow !== undefined && Math.ceil(prompt.length / 3) + maxTokens > contextWindow) {
        throw new Error('research stage input exceeds the model context window')
      }
      const result = await runStage(this.ctx, this.admission, this.config, id, parentAgent,
        { prompt, maxTokens, systemPrompt: RESEARCH_STAGE_SYSTEM_PROMPT, temperature: this.config.stageTemperature }, signal, cwd,
        async (stageSessionId) => {
          await this.storage.checkpoint(id, owner, { round, elapsedMs: Date.now() - startedAt, stageSessionId })
        })
      return result.text
    }
    const plan = await stage(planPrompt(question, date), budgets.planMaxTokens, 0)
    let draft = ''
    let emptyRounds = 0
    let stopped = false
    let stopReason = 'round limit'
    for (let round = 1; round <= budgets.maxRounds; round++) {
      signal.throwIfAborted()
      if (Date.now() - startedAt >= budgets.softRunTimeoutMs) { stopReason = 'soft time budget'; break }
      const count = round === 1 ? budgets.firstRoundQueries : budgets.laterRoundQueries
      const generated = parseQueries(
        await stage(queryPrompt({ question, plan, draft, round, count, date }), budgets.queryMaxTokens, round), count,
      )
      const queries = (generated.length === 0 && round === 1 ? [question] : generated).filter((query) => {
        const key = query.toLocaleLowerCase()
        if (seenQueries.has(key)) return false
        seenQueries.add(key)
        return true
      })
      await this.storage.checkpoint(id, owner, { round, elapsedMs: Date.now() - startedAt, queries })
      const searches = await mapLimit(queries, budgets.maxConcurrentSearches, signal, async (query) => {
        let result: Awaited<ReturnType<Context['web']['search']>>
        try {
          result = await this.ctx.web.search({ query, maxResults: budgets.searchResultsPerQuery }, signal)
        } catch (error) {
          signal.throwIfAborted()
          await this.storage.search(id, owner, { round, query, status: 'error', urls: [], reason: String(error) })
          return []
        }
        signal.throwIfAborted()
        await this.storage.search(id, owner, { round, query, status: 'ok', urls: result.sources.map(source => source.url) })
        return result.sources
      })
      let selectedThisRound = 0
      const candidates = searches.flat().filter((source) => {
        const url = normalizedUrl(source.url)
        if (url === undefined || seenUrls.has(url) || seenUrls.size >= budgets.maxTotalPages) return false
        if (selectedThisRound >= budgets.maxPagesPerRound) return false
        seenUrls.add(url)
        selectedThisRound++
        return true
      })
      const fetched = await mapLimit(candidates, budgets.maxConcurrentFetches, signal, async (candidate) => {
        const retrievedAt = Date.now()
        let result: Awaited<ReturnType<Context['web']['fetch']>>
        try {
          result = await this.ctx.web.fetch({ url: candidate.url }, signal)
        } catch (error) {
          signal.throwIfAborted()
          await this.storage.source(id, owner, { round, requestedUrl: candidate.url, status: 'error', retrievedAt, reason: String(error) })
          return undefined
        }
        signal.throwIfAborted()
        if (result.statusCode < 200 || result.statusCode >= 300) {
          await this.storage.source(id, owner, { round, requestedUrl: candidate.url, finalUrl: result.url,
            statusCode: result.statusCode, retrievedAt, status: 'http_error' })
          return undefined
        }
        const rendered = renderBody(result.body, budgets.maxPageChars)
        const content = rendered.text.slice(0, budgets.maxPageChars)
        const bytes = new TextEncoder().encode(content)
        const ref = await this.ctx.attachments.saveFile({ data: bytes, name: 'research-source.md' })
        signal.throwIfAborted()
        const source: ResearchSource = {
          url: result.url, requestedUrl: candidate.url, title: candidate.title ?? result.url,
          statusCode: result.statusCode, retrievedAt,
          contentSha256: createHash('sha256').update(bytes).digest('hex'), content: ref,
          truncated: result.truncated || rendered.sourceTruncated || rendered.text.length > content.length,
        }
        await this.storage.source(id, owner, { round, requestedUrl: candidate.url, finalUrl: result.url,
          statusCode: result.statusCode, retrievedAt, status: 'fetched', source })
        sources.push(source)
        return { source, content }
      })
      const findings = (await mapLimit(fetched.filter((value): value is NonNullable<typeof value> => value !== undefined),
        budgets.maxConcurrentModelCalls, signal, async ({ source, content }) => {
          const raw = await stage(extractPrompt({ question, url: source.url, content }), budgets.extractMaxTokens, round)
          const parsed = parseFinding(raw)
          await this.storage.finding(id, owner, { round, url: source.url, accepted: parsed !== undefined,
            ...(parsed === undefined ? { reason: 'malformed or low-quality extraction' } : parsed) })
          return parsed === undefined ? undefined : { source, ...parsed }
        })).filter((value): value is Finding => value !== undefined)
      accepted.push(...findings)
      if (findings.length === 0) emptyRounds++
      else emptyRounds = 0
      if (findings.length > 0) {
        const window = findings.slice(-budgets.maxFindingsInSynthesis)
        const synthesis = await stage(synthesisPrompt({ question, draft, findings: window.map(item =>
          `${item.source.url}\nSummary: ${item.summary}\nEvidence: ${item.evidence}`).join('\n\n') }), budgets.reportMaxTokens, round)
        draft = boundReport(synthesis, budgets.maxReportBytes).text
        const draftRef = await this.ctx.attachments.saveFile({ data: new TextEncoder().encode(draft), name: 'research-draft.md' })
        signal.throwIfAborted()
        await this.storage.checkpoint(id, owner, { round, elapsedMs: Date.now() - startedAt, draftRef })
      }
      await this.storage.checkpoint(id, owner, { round, elapsedMs: Date.now() - startedAt,
        urls: candidates.map(candidate => candidate.url), ...(emptyRounds >= budgets.maxEmptyRounds ? { stopReason: 'source unavailable' } : {}) })
      if (emptyRounds >= budgets.maxEmptyRounds) {
        await this.storage.finish(id, owner, { phase: 'failed', reason: 'source unavailable', quality: 'source_unavailable' })
        return
      }
      if (round >= budgets.minRounds && findings.length > 0) {
        const decision = await stage(stopPrompt({ question, draft, round, maxRounds: budgets.maxRounds }), budgets.queryMaxTokens, round)
        if (/^\s*YES\b/iu.test(decision)) { stopped = true; stopReason = decision.trim(); break }
      }
    }
    signal.throwIfAborted()
    if (accepted.length === 0) {
      await this.storage.finish(id, owner, { phase: 'failed', reason: 'source unavailable', quality: 'source_unavailable' })
      return
    }
    const acceptedUrls = new Set(accepted.map(item => normalizedUrl(item.source.url)).filter((url): url is string => url !== undefined))
    const final = await stage(finalPrompt({ question, category, draft, urls: [...acceptedUrls] }),
      budgets.reportMaxTokens, budgets.maxRounds)
    const checked = checkCitationUrls(final, acceptedUrls)
    const bounded = boundReport(checked.markdown, budgets.maxReportBytes)
    const evidence = boundEvidence({ promptVersion: RESEARCH_PROMPT_VERSION, question, category, stopReason,
      stopped, sources, accepted: accepted.map(item => ({ url: item.source.url, summary: item.summary })) }, budgets.maxEvidenceBytes)
    signal.throwIfAborted()
    await this.storage.finish(id, owner, { phase: 'completed', markdown: bounded.text, evidence: evidence.text,
      quality: checked.unsupported.length === 0 && !bounded.truncated && !evidence.truncated ? 'verified_urls' : 'partial' }, signal)
  }
}

/** Bound UTF-8 output before attachment creation.
 * @param text - report or draft text.
 * @param maxBytes - immutable attachment byte ceiling.
 * @returns bounded text and whether bytes were removed.
 */
export function boundReport(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= maxBytes) return { text, truncated: false }
  return { text: new TextDecoder().decode(bytes.slice(0, maxBytes)).replace(/\uFFFD$/u, ''), truncated: true }
}

/** Keep the evidence manifest within its configured immutable-file bound.
 * @param value - run parameters and accepted source ledger.
 * @param maxBytes - immutable evidence attachment byte ceiling.
 * @returns JSON manifest with oldest retained source entries and truncation state.
 */
export function boundEvidence(value: {
  promptVersion: string
  question: string
  category: ResearchCategory
  stopReason: string
  stopped: boolean
  sources: ResearchSource[]
  accepted: Array<{ url: string; summary: string }>
}, maxBytes: number): { text: string; truncated: boolean } {
  const manifest = { ...value, sources: [...value.sources], accepted: [...value.accepted], truncated: false }
  let text = JSON.stringify(manifest)
  while (new TextEncoder().encode(text).length > maxBytes && manifest.accepted.length > 0) {
    manifest.accepted.pop()
    manifest.truncated = true
    text = JSON.stringify(manifest)
  }
  while (new TextEncoder().encode(text).length > maxBytes && manifest.sources.length > 0) {
    manifest.sources.pop()
    manifest.truncated = true
    text = JSON.stringify(manifest)
  }
  if (new TextEncoder().encode(text).length > maxBytes) throw new Error('research evidence exceeds configured byte limit')
  return { text, truncated: manifest.truncated }
}
