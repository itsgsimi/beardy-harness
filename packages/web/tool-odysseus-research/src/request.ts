/**
 * Bounded, non-retrying requests to Odysseus research routes.
 * @module @deepseek-ai/dsh-tool-odysseus-research/request
 */
import type { Branded } from '@deepseek-ai/dsh-brand'
import { deadline } from '@deepseek-ai/dsh-timeout'
import type { Config } from './index.ts'

/** Saved report retained for the native viewer outside the model text page. */
export interface ResearchArtifact {
  /** Remote job identity. */
  id: string
  /** Complete report Markdown. */
  markdown: string
  /** Ordered citation targets from Odysseus. */
  sources: { url: string; title?: string }[]
}

/** Model text and optional durable native report. */
export interface ResearchResponse {
  /** Complete operation result or one JSON text page. */
  text: string
  /** Complete artifact on the first report page only. */
  artifact?: ResearchArtifact
}

type ResearchId = Branded<'OdysseusResearchId'>

/** Model-supplied operation; server and worker choices belong to configuration. */
export interface ResearchRequest {
  /** One operation on Odysseus research jobs. */
  action: string
  /** Question for start or title filter for list. */
  query?: string
  /** Remote id from start or list. */
  id?: string
  /** Unicode character offset for read operations. */
  offset?: number
}

function researchId(value: string | undefined): ResearchId {
  if (value === undefined || !/^[a-zA-Z0-9-]{1,128}$/.test(value)) {
    throw new Error('Odysseus research id must contain 1–128 letters, digits, or hyphens')
  }
  return value as ResearchId
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Odysseus returned an invalid research response')
  }
  return value as Record<string, unknown>
}

/**
 * Execute one operation; never retry a potentially accepted remote mutation.
 * @param config - resolved endpoint, model, and bounds.
 * @param token - credential used only in the Authorization header.
 * @param args - tool arguments validated before network access.
 * @param signal - cancels HTTP work, not the independently owned remote job.
 * @returns a complete JSON response page with an explicit continuation offset.
 */
export async function requestResearch(
  config: Required<Omit<Config, 'workerLabel'>>, token: string, args: ResearchRequest, signal: AbortSignal,
): Promise<ResearchResponse> {
  const offset = args.offset ?? 0
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a non-negative safe integer')
  if ((args.action === 'start' || args.action === 'cancel') && offset !== 0) {
    throw new Error('start and cancel do not accept a page offset')
  }
  using operation = deadline(signal, config.requestTimeoutMs, 'ODYSSEUS_REQUEST_TIMEOUT')
  const request = async (path: string, body?: unknown): Promise<Record<string, unknown>> => {
    const response = await fetch(`${config.baseURL.replace(/\/$/, '')}/api/research/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error', signal: operation.signal,
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Odysseus research HTTP ${response.status}; check authentication, research scopes, and endpoint configuration`)
    }
    if (response.body === null) throw new Error('Odysseus returned an empty response')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > config.maxResponseBytes) {
          await reader.cancel()
          throw new Error('Odysseus response exceeds maxResponseBytes; increase the configured limit to read it')
        }
        chunks.push(chunk.value)
      }
    } finally {
      reader.releaseLock()
    }
    return record(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
  }
  let artifact: ResearchArtifact | undefined
  let result: Record<string, unknown>
  switch (args.action) {
    case 'start': {
      if (!args.query?.trim()) throw new Error('start requires a non-empty query')
      const started = await request('start', {
        query: args.query.trim(), endpoint_id: config.endpointId, model: config.model,
        max_rounds: config.maxRounds, max_time: config.maxTimeSeconds,
        ...(config.disableThinking ? { enable_thinking: false } : {}),
      })
      const id = researchId(typeof started.session_id === 'string' ? started.session_id : undefined)
      if (started.status !== 'running') throw new Error('Odysseus did not acknowledge a running research job')
      return { text: JSON.stringify({ id, status: 'running', model: config.model }) }
    }
    case 'cancel': {
      const id = researchId(args.id)
      const cancelled = await request(`cancel/${id}`, {})
      if (typeof cancelled.cancelled !== 'boolean') throw new Error('Odysseus returned an invalid cancellation response')
      return { text: JSON.stringify({ id, cancellation_requested: cancelled.cancelled }) }
    }
    case 'status':
      result = await request(`status/${researchId(args.id)}`)
      if (typeof result.status !== 'string') throw new Error('Odysseus returned an invalid research status')
      break
    case 'report': {
      const report = await request(`result-peek/${researchId(args.id)}`, {})
      if (typeof report.result !== 'string' || !Array.isArray(report.sources)) {
        throw new Error('Odysseus returned an invalid report or sources')
      }
      const sources = report.sources.map((item: unknown) => {
        const source = record(item)
        if (typeof source.url !== 'string' || (source.title !== undefined && typeof source.title !== 'string')) {
          throw new Error('Odysseus returned an invalid report source')
        }
        return { url: source.url, ...(source.title === undefined ? {} : { title: source.title }) }
      })
      result = { report: report.result, sources }
      if (offset === 0) artifact = { id: researchId(args.id), markdown: report.result, sources }
      break
    }
    case 'list': {
      const active = await request('active')
      const library = await request(`library?limit=20&search=${encodeURIComponent(args.query ?? '')}`)
      if (!Array.isArray(active.active) || !Array.isArray(library.research)) {
        throw new Error('Odysseus returned an invalid research list')
      }
      result = { active: active.active, saved: library.research, total_saved: library.total }
      break
    }
    default:
      throw new Error('Unknown Odysseus research action')
  }
  const text = Array.from(JSON.stringify(result))
  if (offset > text.length) throw new Error('offset exceeds the response length')
  const end = Math.min(offset + config.pageChars, text.length)
  return {
    text: JSON.stringify({ text: text.slice(offset, end).join(''), next_offset: end < text.length ? end : null, total_chars: text.length }),
    ...(artifact === undefined ? {} : { artifact }),
  }
}
