/** Session-backed local research storage and recovery. @module @deepseek-ai/dsh-research-local */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ResearchRunId, ResearchService } from '@deepseek-ai/dsh-research'
import type { ResearchList, ResearchStart } from '@deepseek-ai/dsh-research'
import type {
  ResearchBudgets, ResearchCheckpoint, ResearchFinding, ResearchFinished, ResearchOwner, ResearchReport, ResearchRunId as RunId,
  ResearchRunView, ResearchSearch, ResearchSource, ResearchSourceAttempt, ResearchStarted,
} from '@deepseek-ai/dsh-research/types'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-web'
import { resolveConfig, type Config, type ResolvedConfig } from './config.ts'
import { DEFAULT_BUDGETS } from './config.ts'
import { ResearchEngine } from './engine.ts'
import { RESEARCH_PROMPT_VERSION } from './prompts.ts'
import { StageAdmission } from './stage.ts'
import { runWorkflow, workflowBudgets } from './workflow.ts'

export type { Config } from './config.ts'

/** The durable run ID prefix also selects candidate Sessions from persistence. */
export const RESEARCH_RUN_PREFIX = 'rp-native-'

interface ProjectedRun {
  readonly started: ResearchStarted
  readonly view: ResearchRunView
  readonly finished?: ResearchFinished
  readonly reportRef?: FileAttachmentRef
  readonly evidenceRef?: FileAttachmentRef
  readonly draftRef?: FileAttachmentRef
  readonly sources: readonly ResearchSource[]
}

function sameOwner(a: ResearchOwner, b: ResearchOwner): boolean {
  return a.kind === b.kind && (a.kind === 'session'
    ? b.kind === 'session' && a.sessionId === b.sessionId
    : b.kind === 'profile' && a.namespace === b.namespace)
}

/**
 * Fold only a run Session's committed research events.
 * @param events - persisted Session events in sequence order.
 * @returns run state, or undefined before the start event.
 */
export function projectResearchRun(events: readonly SessionEvent[]): ProjectedRun | undefined {
  let started: ResearchStarted | undefined
  let finished: ResearchFinished | undefined
  let round = 0
  let updatedAt = 0
  let draftRef: FileAttachmentRef | undefined
  const stageSessionIds: SessionId[] = []
  const sources: ResearchSource[] = []
  for (const event of events) {
    switch (event.type) {
      case 'research/started':
        if (started !== undefined) throw new Error('research run has duplicate start events')
        started = event.data
        updatedAt = event.data.createdAt
        break
      case 'research/checkpoint':
        if (started === undefined || finished !== undefined) throw new Error('research checkpoint outside a running run')
        round = Math.max(round, event.data.round)
        if (event.data.stageSessionId !== undefined) stageSessionIds.push(event.data.stageSessionId)
        if (event.data.source !== undefined) sources.push(event.data.source)
        if (event.data.draftRef !== undefined) draftRef = event.data.draftRef
        updatedAt = event.time
        break
      case 'research/source':
        if (started === undefined || finished !== undefined) throw new Error('research source outside a running run')
        if (event.data.source !== undefined) sources.push(event.data.source)
        updatedAt = event.time
        break
      case 'research/finished':
        if (started === undefined || finished !== undefined) throw new Error('research run has invalid terminal events')
        if ((event.data.reportRef === undefined) !== (event.data.evidenceRef === undefined)) {
          throw new Error('research terminal event has incomplete report references')
        }
        if (event.data.phase === 'completed' && event.data.reportRef === undefined) {
          throw new Error('completed research run has no report')
        }
        finished = event.data
        updatedAt = event.data.finishedAt
        break
      default:
        break
    }
  }
  if (started === undefined) return undefined
  return {
    started,
    ...(finished === undefined ? {} : { finished }),
    ...(finished?.reportRef === undefined ? {} : { reportRef: finished.reportRef }),
    ...(finished?.evidenceRef === undefined ? {} : { evidenceRef: finished.evidenceRef }),
    ...(draftRef === undefined ? {} : { draftRef }),
    sources,
    view: {
      id: started.id,
      owner: started.owner,
      callerSessionId: started.callerSessionId,
      query: started.query,
      phase: finished?.phase ?? 'running',
      round,
      stageSessionIds,
      sourceCount: sources.length,
      createdAt: started.createdAt,
      updatedAt,
      provider: started.provider,
      model: started.model,
      reportAvailable: finished?.reportRef !== undefined && finished.evidenceRef !== undefined,
      ...(finished?.reason === undefined ? {} : { reason: finished.reason }),
    },
  }
}

/** Durable local run storage and versioned general research worker. */
export class LocalResearchService extends ResearchService {
  static inject = ['agents', 'sessions', 'sessionPersistence', 'attachments', 'llm', 'web', 'tools']
  static Config: z<Config> = z.object({
    provider: z.string().min(1), model: z.string().min(1), reasoningEffort: z.string().min(1),
    ownerScope: z.union(['session', 'profile']).default('session'), ownerNamespace: z.string().min(1),
    maxRounds: z.number().step(1).min(1).max(20).default(4),
    minRounds: z.number().step(1).min(1).max(20).default(2),
    firstRoundQueries: z.number().step(1).min(1).max(20).default(4),
    laterRoundQueries: z.number().step(1).min(1).max(20).default(3),
    searchResultsPerQuery: z.number().step(1).min(1).max(20).default(10),
    maxPagesPerRound: z.number().step(1).min(1).max(20).default(8),
    maxTotalPages: z.number().step(1).min(1).max(200).default(24),
    maxPageChars: z.number().step(1).min(1000).max(100000).default(12000),
    maxFindingsInSynthesis: z.number().step(1).min(1).max(100).default(10),
    maxConcurrentSearches: z.number().step(1).min(1).max(12).default(2),
    maxConcurrentFetches: z.number().step(1).min(1).max(12).default(3),
    maxConcurrentModelCalls: z.number().step(1).min(1).max(12).default(1),
    softRunTimeoutMs: z.number().step(1).min(1).max(86400000).default(300000),
    hardRunTimeoutMs: z.number().step(1).min(1).max(86400000).default(1800000),
    stageTimeoutMs: z.number().step(1).min(1).max(86400000).default(240000),
    planMaxTokens: z.number().step(1).min(1).max(1000000).default(1024),
    queryMaxTokens: z.number().step(1).min(1).max(1000000).default(2048),
    extractMaxTokens: z.number().step(1).min(1).max(1000000).default(2048),
    reportMaxTokens: z.number().step(1).min(1).max(1000000).default(8192),
    maxEmptyRounds: z.number().step(1).min(1).max(20).default(2),
    reportPageChars: z.number().step(1).min(1).max(1000000).default(16000),
    maxReportBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(1048576),
    maxEvidenceBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(8388608),
  })

  private readonly config: ResolvedConfig
  private readonly admission: StageAdmission
  private readonly engine: ResearchEngine
  private readonly live = new Map<RunId, AgentHandle>()
  private readonly workers = new Map<RunId, { controller: AbortController; task: Promise<void> }>()
  private readonly uncertain = new Set<RunId>()
  private mutation = Promise.resolve()
  private reconciled = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = resolveConfig(config)
    this.admission = new StageAdmission(this.config.budgets.maxConcurrentModelCalls)
    this.engine = new ResearchEngine(ctx, this.config, this, this.admission)
    ctx.effect(() => () => this.disposeRuns(), 'research run teardown')
  }

  private async serialized<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.mutation
    const done = Promise.withResolvers<void>()
    this.mutation = done.promise
    await previous
    try {
      return await work()
    } finally {
      done.resolve()
    }
  }

  private async ensureReconciled(): Promise<void> {
    if (this.reconciled) return
    await this.reconcile()
    this.reconciled = true
  }

  private assertOwner(caller: Session, owner: ResearchOwner): void {
    if (this.ctx.sessions.get(caller.id) !== caller) throw new Error('research caller Session is not live')
    if (this.config.ownerScope === 'session') {
      if (owner.kind !== 'session' || owner.sessionId !== caller.id) throw new Error('research owner is not the caller Session')
    } else if (owner.kind !== 'profile' || owner.namespace !== this.config.ownerNamespace) {
      throw new Error('research owner is not the configured profile')
    }
  }

  ownerFor(caller: Session): ResearchOwner {
    if (this.ctx.sessions.get(caller.id) !== caller) throw new Error('research caller Session is not live')
    if (this.config.ownerScope === 'session') return { kind: 'session', sessionId: caller.id }
    return { kind: 'profile', namespace: this.config.ownerNamespace }
  }

  private async readRun(id: RunId): Promise<ProjectedRun> {
    if (!id.startsWith(RESEARCH_RUN_PREFIX)) throw new Error('research run unavailable')
    let events: readonly SessionEvent[]
    try {
      const handle = await this.ctx.sessionPersistence.open(SessionId(id), 'read')
      try {
        events = (await handle.read()).events
      } finally {
        await handle.close()
      }
    } catch (error) {
      throw new Error('research run unavailable', { cause: error })
    }
    const projected = projectResearchRun(events)
    if (projected === undefined || projected.started.id !== id) throw new Error('research run unavailable')
    return projected
  }

  private async owned(id: RunId, owner: ResearchOwner): Promise<ProjectedRun> {
    const run = await this.readRun(id)
    if (!sameOwner(run.started.owner, owner)) throw new Error('research run unavailable')
    return run
  }

  private writable(id: RunId): Session {
    if (this.uncertain.has(id)) throw new Error('research run durability is uncertain; inspect it after restart')
    const session = this.live.get(id)?.agent.session
    if (session === undefined) throw new Error('research run is not active in this process')
    return session
  }

  private async flushRun(id: RunId, session: Session): Promise<void> {
    try {
      if (!await this.ctx.sessions.flush(session)) throw new Error('research run has no durability provider')
    } catch (error) {
      this.uncertain.add(id)
      throw error
    }
  }

  private async allRuns(): Promise<ProjectedRun[]> {
    const snapshots = await this.ctx.sessionPersistence.list()
    const runs: ProjectedRun[] = []
    for (const snapshot of snapshots) {
      if (!snapshot.header.id.startsWith(RESEARCH_RUN_PREFIX)) continue
      const run = await this.readRun(ResearchRunId(snapshot.header.id))
      runs.push(run)
    }
    return runs
  }

  /** Budgets recorded for and enforced on one run: provider values, with a workflow's deadlines applied. */
  private runBudgets(request: ResearchStart): ResearchBudgets {
    if (request.workflow === undefined) return this.config.budgets
    if (request.category !== undefined) throw new Error('research workflow runs take no category')
    return workflowBudgets(request.workflow, this.config.budgets)
  }

  async start(request: ResearchStart): Promise<ResearchRunView> {
    const budgets = this.runBudgets(request)
    if (request.workflow === undefined) this.ctx.web.assertAvailable()
    const info = await this.ctx.llm.resolveModelInfo(this.config.provider, this.config.model)
    if (this.config.reasoningEffort !== undefined
      && !info.reasoning?.efforts.some(effort => effort.id === this.config.reasoningEffort)) {
      throw new Error('research reasoningEffort is not supported by the model route')
    }
    const outputCeiling = Math.max(this.config.budgets.planMaxTokens, this.config.budgets.queryMaxTokens,
      this.config.budgets.extractMaxTokens, this.config.budgets.reportMaxTokens)
    if (info.context !== undefined && outputCeiling >= info.context.contextWindow) {
      throw new Error('research stage maxTokens exceeds the model context window')
    }
    const view = await this.startStored(request)
    if (view.phase !== 'running' || this.workers.has(view.id)) return view
    const parentAgent = this.live.get(view.id)?.agent
    if (parentAgent === undefined) throw new Error('research run has no live Agent')
    const controller = new AbortController()
    const startedAt = Date.now()
    const timer = setTimeout(() => { controller.abort({ kind: 'timeout' }) }, budgets.hardRunTimeoutMs)
    const cwd = request.caller.header.cwd
    const task = (request.workflow === undefined
      ? this.engine.run(view.id, parentAgent, request.owner, view.query, request.category ?? 'general', controller.signal,
        startedAt, info.context?.contextWindow, cwd)
      : runWorkflow(this.ctx, this.admission, { ...this.config, budgets }, this, request.workflow, {
        id: view.id, parentAgent, owner: request.owner, signal: controller.signal, startedAt,
        contextWindow: info.context?.contextWindow, cwd,
      })).catch(async (error: unknown) => {
      const abortReason = controller.signal.reason as { kind?: 'cancel' | 'timeout' | 'shutdown' } | undefined
      if (abortReason?.kind === 'cancel') return
      if (this.uncertain.has(view.id)) throw error
      const timeout = abortReason?.kind === 'timeout' || String(error).includes('research stage timeout')
      const shutdown = abortReason?.kind === 'shutdown'
      const partial = await this.partialResult(await this.owned(view.id, request.owner))
      await this.finish(view.id, request.owner, {
        phase: shutdown ? 'interrupted' : timeout ? 'budget_exhausted' : 'failed',
        reason: shutdown ? 'provider shutdown' : timeout ? 'hard time budget' : String(error),
        quality: 'partial',
        ...partial,
      })
    }).finally(() => {
      clearTimeout(timer)
      this.workers.delete(view.id)
    })
    this.workers.set(view.id, { controller, task })
    void task.catch(() => {})
    return view
  }

  /**
   * Wait for a live engine worker to settle; a completed or recovered run resolves immediately.
   * @param id - run identity returned by start.
   * @returns after the active worker and its terminal commit settle.
   */
  async whenDone(id: RunId): Promise<void> {
    await this.workers.get(id)?.task
  }

  /**
   * Commit a run without launching the engine. Storage and recovery callers use this boundary.
   * @param request - trusted caller, owner, question and optional exact request key.
   * @returns the durable run view after caller linkage.
   */
  async startStored(request: ResearchStart): Promise<ResearchRunView> {
    const category = request.category
    const budgets = this.runBudgets(request)
    await this.ensureReconciled()
    return this.serialized(async () => {
      this.assertOwner(request.caller, request.owner)
      const query = request.query.trim()
      if (!query) throw new Error('research query must be nonblank')
      if (request.requestKey !== undefined && !request.requestKey.trim()) throw new Error('research requestKey must be nonblank')
      if (request.requestKey !== undefined) {
        const existing = (await this.allRuns()).find(run => run.started.callerSessionId === request.caller.id
          && run.started.requestKey === request.requestKey && sameOwner(run.started.owner, request.owner))
        if (existing !== undefined) {
          if (existing.started.query !== query) throw new Error('research requestKey was used for a different query')
          request.caller.append('research/linked', { id: existing.started.id })
          if (!await this.ctx.sessions.flush(request.caller)) throw new Error('research caller has no durability provider')
          return existing.view
        }
      }
      const id = ResearchRunId(`${RESEARCH_RUN_PREFIX}${randomUUID()}`)
      const handle = await this.ctx.agents.create({ sessionId: SessionId(id),
        ...(request.caller.header.cwd === undefined ? {} : { meta: { cwd: request.caller.header.cwd } }) })
      const run = handle.agent.session
      this.live.set(id, handle)
      const started: ResearchStarted = {
        id,
        owner: request.owner,
        callerSessionId: request.caller.id,
        query,
        ...(request.requestKey === undefined ? {} : { requestKey: request.requestKey }),
        provider: this.config.provider,
        model: this.config.model,
        ...(this.config.reasoningEffort === undefined ? {} : { reasoningEffort: this.config.reasoningEffort }),
        ...(category === undefined ? {} : { category }),
        ...(request.workflow === undefined ? {} : { workflow: request.workflow.name }),
        promptVersion: request.workflow?.promptVersion ?? RESEARCH_PROMPT_VERSION,
        budgets,
        createdAt: Date.now(),
      }
      try {
        run.append('research/started', started)
        if (!await this.ctx.sessions.flush(run)) throw new Error('research run has no durability provider')
        request.caller.append('research/linked', { id })
        if (!await this.ctx.sessions.flush(request.caller)) throw new Error('research caller has no durability provider')
      } catch (error) {
        await this.disposeRun(id, handle)
        throw error
      }
      const view = (await this.readRun(id)).view
      this.ctx.emit('research/changed', { run: view })
      return view
    })
  }

  async status(id: RunId, owner: ResearchOwner): Promise<ResearchRunView> {
    await this.ensureReconciled()
    return (await this.owned(id, owner)).view
  }

  async list(request: ResearchList): Promise<readonly ResearchRunView[]> {
    await this.ensureReconciled()
    if (!Number.isSafeInteger(request.limit) || request.limit < 1) throw new Error('research list limit must be positive')
    const runs = (await this.allRuns()).filter(run => sameOwner(run.started.owner, request.owner))
      .filter(run => request.query === undefined || run.started.query.toLowerCase().includes(request.query.toLowerCase()))
      .sort((a, b) => b.started.createdAt - a.started.createdAt || a.started.id.localeCompare(b.started.id))
    const start = request.cursor === undefined ? 0 : runs.findIndex(run => run.started.id === request.cursor) + 1
    return runs.slice(start, start + request.limit).map(run => run.view)
  }

  private async readAttachment(ref: FileAttachmentRef, maxBytes: number): Promise<string> {
    if (ref.bytes > maxBytes) throw new Error('research attachment exceeds configured byte limit')
    const chunks: Uint8Array[] = []
    let total = 0
    for await (const chunk of this.ctx.attachments.readFileStream(ref)) {
      total += chunk.byteLength
      if (total > maxBytes) throw new Error('research attachment exceeds configured byte limit')
      chunks.push(chunk)
    }
    if (total !== ref.bytes) throw new Error('research attachment byte count changed')
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  }

  private async partialResult(run: ProjectedRun): Promise<{ markdown?: string; evidence?: string }> {
    if (run.draftRef === undefined) return {}
    const markdown = await this.readAttachment(run.draftRef, this.config.budgets.maxReportBytes)
    const urls = run.sources.map(source => source.url)
    let evidence = JSON.stringify({ partial: true, sourceUrls: urls })
    while (new TextEncoder().encode(evidence).length > this.config.budgets.maxEvidenceBytes && urls.length > 0) {
      urls.pop()
      evidence = JSON.stringify({ partial: true, sourceUrls: urls, truncated: true })
    }
    if (new TextEncoder().encode(evidence).length > this.config.budgets.maxEvidenceBytes) return {}
    return { markdown, evidence }
  }

  private async saveReportFiles(markdown: string, evidence: string, signal?: AbortSignal): Promise<{
    reportRef: FileAttachmentRef
    evidenceRef: FileAttachmentRef
  }> {
    const reportBytes = new TextEncoder().encode(markdown)
    const evidenceBytes = new TextEncoder().encode(evidence)
    if (reportBytes.byteLength > this.config.budgets.maxReportBytes || evidenceBytes.byteLength > this.config.budgets.maxEvidenceBytes) {
      throw new Error('research report or evidence exceeds configured byte limit')
    }
    const reportRef = await this.ctx.attachments.saveFile({ data: reportBytes, name: 'research-report.md' })
    signal?.throwIfAborted()
    const evidenceRef = await this.ctx.attachments.saveFile({ data: evidenceBytes, name: 'research-evidence.json' })
    signal?.throwIfAborted()
    return { reportRef, evidenceRef }
  }

  async report(id: RunId, owner: ResearchOwner): Promise<ResearchReport> {
    await this.ensureReconciled()
    const run = await this.owned(id, owner)
    if (run.reportRef === undefined || run.evidenceRef === undefined) throw new Error('research report unavailable')
    const markdown = await this.readAttachment(run.reportRef, this.config.budgets.maxReportBytes)
    await this.readAttachment(run.evidenceRef, this.config.budgets.maxEvidenceBytes)
    return { runId: id, complete: run.finished?.phase === 'completed', markdown, sources: run.sources,
      pageChars: run.started.budgets?.reportPageChars ?? DEFAULT_BUDGETS.reportPageChars,
      reportRef: run.reportRef, evidenceRef: run.evidenceRef }
  }

  /**
   * Commit one engine checkpoint before progress may be published.
   * @param id - active run identity.
   * @param owner - run owner.
   * @param checkpoint - progress and durable source references.
   * @returns committed run view.
   */
  async checkpoint(id: RunId, owner: ResearchOwner, checkpoint: ResearchCheckpoint): Promise<ResearchRunView> {
    await this.ensureReconciled()
    return this.serialized(async () => {
      const run = await this.owned(id, owner)
      if (run.finished !== undefined) return run.view
      const session = this.writable(id)
      session.append('research/checkpoint', checkpoint)
      await this.flushRun(id, session)
      const view = (await this.readRun(id)).view
      this.ctx.emit('research/changed', { run: view })
      return view
    })
  }

  /** Commit one search outcome to the run log.
   * @param id - run identity.
   * @param owner - trusted run authority.
   * @param result - committed search outcome.
   */
  async search(id: RunId, owner: ResearchOwner, result: ResearchSearch): Promise<void> {
    await this.record(id, owner, session => session.append('research/search', result))
  }

  /** Commit one fetch outcome to the run log.
   * @param id - run identity.
   * @param owner - trusted run authority.
   * @param result - committed fetch outcome.
   */
  async source(id: RunId, owner: ResearchOwner, result: ResearchSourceAttempt): Promise<void> {
    await this.record(id, owner, session => session.append('research/source', result))
  }

  /** Commit one normalized extraction to the run log.
   * @param id - run identity.
   * @param owner - trusted run authority.
   * @param result - normalized extraction.
   */
  async finding(id: RunId, owner: ResearchOwner, result: ResearchFinding): Promise<void> {
    await this.record(id, owner, session => session.append('research/finding', result))
  }

  private async record(id: RunId, owner: ResearchOwner, append: (session: Session) => void): Promise<void> {
    await this.ensureReconciled()
    await this.serialized(async () => {
      const run = await this.owned(id, owner)
      if (run.finished !== undefined) return
      const session = this.writable(id)
      append(session)
      await this.flushRun(id, session)
    })
  }

  /**
   * Commit immutable files before a terminal event. A rejected save leaves the run open.
   * @param id - active run identity.
   * @param owner - run owner.
   * @param result - terminal phase and report bytes; completion requires both files.
   * @param signal - optional cancellation through attachment and terminal commit.
   * @returns committed run view; an existing terminal result wins.
   */
  async finish(
    id: RunId,
    owner: ResearchOwner,
    result: Omit<ResearchFinished, 'finishedAt' | 'reportRef' | 'evidenceRef'> & {
      readonly markdown?: string
      readonly evidence?: string
    },
    signal?: AbortSignal,
  ): Promise<ResearchRunView> {
    await this.ensureReconciled()
    return this.serialized(async () => {
      signal?.throwIfAborted()
      const run = await this.owned(id, owner)
      if (run.finished !== undefined) return run.view
      const session = this.writable(id)
      let refs: { reportRef: FileAttachmentRef; evidenceRef: FileAttachmentRef } | undefined
      if (result.markdown === undefined) {
        if (result.evidence !== undefined) throw new Error('research report and evidence must be committed together')
        if (result.phase === 'completed') throw new Error('completed research requires report and evidence')
      } else {
        if (result.evidence === undefined) throw new Error('research report and evidence must be committed together')
        refs = await this.saveReportFiles(result.markdown, result.evidence, signal)
      }
      signal?.throwIfAborted()
      session.append('research/finished', {
        phase: result.phase,
        finishedAt: Date.now(),
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        ...(result.quality === undefined ? {} : { quality: result.quality }),
        ...refs,
      })
      await this.flushRun(id, session)
      const view = (await this.readRun(id)).view
      this.ctx.emit('research/changed', { run: view })
      return view
    })
  }

  async cancel(id: RunId, owner: ResearchOwner): Promise<{ requested: boolean }> {
    await this.ensureReconciled()
    await this.owned(id, owner)
    const worker = this.workers.get(id)
    worker?.controller.abort({ kind: 'cancel' })
    const result = await this.serialized(async () => {
      const run = await this.owned(id, owner)
      if (run.finished !== undefined) return { requested: false }
      const session = this.writable(id)
      const partial = await this.partialResult(run)
      const refs = partial.markdown !== undefined && partial.evidence !== undefined
        ? await this.saveReportFiles(partial.markdown, partial.evidence)
        : undefined
      session.append('research/finished', {
        phase: 'cancelled', finishedAt: Date.now(), reason: 'cancelled by owner',
        ...refs,
      })
      await this.flushRun(id, session)
      this.ctx.emit('research/changed', { run: (await this.readRun(id)).view })
      return { requested: true }
    })
    await worker?.task
    return result
  }

  /** Mark persisted running records interrupted after restart without replaying external effects. */
  async reconcile(): Promise<void> {
    await this.serialized(async () => {
      for (const run of await this.allRuns()) {
        if (run.finished !== undefined || this.live.has(run.started.id)) continue
        const handle = await this.ctx.agents.resume({ resumeSessionId: SessionId(run.started.id) })
        try {
          const partial = await this.partialResult(run)
          const refs = partial.markdown !== undefined && partial.evidence !== undefined
            ? await this.saveReportFiles(partial.markdown, partial.evidence)
            : undefined
          handle.agent.session.append('research/finished', {
            phase: 'interrupted', finishedAt: Date.now(), reason: 'provider restarted before run completed',
            ...refs,
          })
          if (!await this.ctx.sessions.flush(handle.agent.session)) throw new Error('research run has no durability provider')
          this.ctx.emit('research/changed', { run: (await this.readRun(run.started.id)).view })
        } finally {
          await handle.dispose()
        }
      }
    })
    this.reconciled = true
  }

  private async disposeRun(id: RunId, handle: AgentHandle): Promise<void> {
    this.live.delete(id)
    await handle.dispose()
  }

  private async disposeRuns(): Promise<void> {
    for (const { controller } of this.workers.values()) controller.abort({ kind: 'shutdown' })
    await Promise.all([...this.workers.values()].map(worker => worker.task))
    await this.mutation
    await Promise.all([...this.live].map(([id, handle]) => this.disposeRun(id, handle)))
  }
}

export default LocalResearchService
