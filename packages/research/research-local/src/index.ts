/** Session-backed local research storage and recovery. @module @deepseek-ai/dsh-research-local */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ResearchRunId, ResearchService } from '@deepseek-ai/dsh-research'
import type { ResearchList, ResearchStart } from '@deepseek-ai/dsh-research'
import type {
  ResearchCheckpoint, ResearchFinished, ResearchOwner, ResearchReport, ResearchRunId as RunId, ResearchRunView,
  ResearchSource, ResearchStarted,
} from '@deepseek-ai/dsh-research/types'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-session-persistence'

/** The durable run ID prefix also selects candidate Sessions from persistence. */
export const RESEARCH_RUN_PREFIX = 'rp-native-'

/** Storage configuration. The engine's model and budget settings arrive in slice 2. */
export interface Config {
  /** Exact model provider route recorded with each run. */
  provider: string
  /** Exact model name recorded with each run. */
  model: string
  /** Session isolation by default; profile scope requires a single-user deployment. */
  ownerScope?: 'session' | 'profile'
  /** Stable single-user profile authority, required with profile scope. */
  ownerNamespace?: string
  /** Maximum report bytes committed as one immutable attachment. Default: 1048576. */
  maxReportBytes?: number
  /** Maximum evidence-manifest bytes committed as one immutable attachment. Default: 8388608. */
  maxEvidenceBytes?: number
}

interface ProjectedRun {
  readonly started: ResearchStarted
  readonly view: ResearchRunView
  readonly finished?: ResearchFinished
  readonly reportRef?: FileAttachmentRef
  readonly evidenceRef?: FileAttachmentRef
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

/** Durable local implementation; no model worker runs in this slice. */
export class LocalResearchService extends ResearchService {
  static inject = ['agents', 'sessions', 'sessionPersistence', 'attachments']
  static Config: z<Config> = z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    ownerScope: z.union(['session', 'profile']).default('session'),
    ownerNamespace: z.string().min(1),
    maxReportBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(1048576),
    maxEvidenceBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(8388608),
  })

  private readonly config: Required<Pick<Config, 'provider' | 'model' | 'ownerScope' | 'maxReportBytes' | 'maxEvidenceBytes'>> & Pick<Config, 'ownerNamespace'>
  private readonly live = new Map<RunId, AgentHandle>()
  private readonly uncertain = new Set<RunId>()
  private mutation = Promise.resolve()
  private reconciled = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    if (!config.provider.trim() || !config.model.trim()) throw new Error('research provider and model must be nonblank')
    const ownerScope = config.ownerScope ?? 'session'
    if (ownerScope === 'profile' && !config.ownerNamespace?.trim()) {
      throw new Error('research profile owner scope requires ownerNamespace')
    }
    if (ownerScope === 'session' && config.ownerNamespace !== undefined) {
      throw new Error('research ownerNamespace requires profile owner scope')
    }
    this.config = {
      provider: config.provider,
      model: config.model,
      ownerScope,
      ...(config.ownerNamespace === undefined ? {} : { ownerNamespace: config.ownerNamespace }),
      maxReportBytes: config.maxReportBytes ?? 1048576,
      maxEvidenceBytes: config.maxEvidenceBytes ?? 8388608,
    }
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

  async start(request: ResearchStart): Promise<ResearchRunView> {
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
      const handle = await this.ctx.agents.create({ sessionId: SessionId(id) })
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

  async report(id: RunId, owner: ResearchOwner): Promise<ResearchReport> {
    await this.ensureReconciled()
    const run = await this.owned(id, owner)
    if (run.reportRef === undefined || run.evidenceRef === undefined) throw new Error('research report unavailable')
    const markdown = await this.readAttachment(run.reportRef, this.config.maxReportBytes)
    await this.readAttachment(run.evidenceRef, this.config.maxEvidenceBytes)
    return { runId: id, complete: run.finished?.phase === 'completed', markdown, sources: run.sources,
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

  /**
   * Commit immutable files before a terminal event. A rejected save leaves the run open.
   * @param id - active run identity.
   * @param owner - run owner.
   * @param result - terminal phase and report bytes; completion requires both files.
   * @returns committed run view; an existing terminal result wins.
   */
  async finish(
    id: RunId,
    owner: ResearchOwner,
    result: Omit<ResearchFinished, 'finishedAt' | 'reportRef' | 'evidenceRef'> & {
      readonly markdown?: string
      readonly evidence?: string
    },
  ): Promise<ResearchRunView> {
    await this.ensureReconciled()
    return this.serialized(async () => {
      const run = await this.owned(id, owner)
      if (run.finished !== undefined) return run.view
      const session = this.writable(id)
      let refs: { reportRef: FileAttachmentRef; evidenceRef: FileAttachmentRef } | undefined
      if (result.markdown === undefined) {
        if (result.evidence !== undefined) throw new Error('research report and evidence must be committed together')
        if (result.phase === 'completed') throw new Error('completed research requires report and evidence')
      } else {
        if (result.evidence === undefined) throw new Error('research report and evidence must be committed together')
        const reportBytes = new TextEncoder().encode(result.markdown)
        const evidenceBytes = new TextEncoder().encode(result.evidence)
        if (reportBytes.byteLength > this.config.maxReportBytes || evidenceBytes.byteLength > this.config.maxEvidenceBytes) {
          throw new Error('research report or evidence exceeds configured byte limit')
        }
        const reportRef = await this.ctx.attachments.saveFile({ data: reportBytes, name: 'research-report.md' })
        const evidenceRef = await this.ctx.attachments.saveFile({ data: evidenceBytes, name: 'research-evidence.json' })
        refs = { reportRef, evidenceRef }
      }
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
    return this.serialized(async () => {
      const run = await this.owned(id, owner)
      if (run.finished !== undefined) return { requested: false }
      const session = this.writable(id)
      session.append('research/finished', {
        phase: 'cancelled', finishedAt: Date.now(), reason: 'cancelled by owner',
      })
      await this.flushRun(id, session)
      this.ctx.emit('research/changed', { run: (await this.readRun(id)).view })
      return { requested: true }
    })
  }

  /** Mark persisted running records interrupted after restart without replaying external effects. */
  async reconcile(): Promise<void> {
    await this.serialized(async () => {
      for (const run of await this.allRuns()) {
        if (run.finished !== undefined || this.live.has(run.started.id)) continue
        const handle = await this.ctx.agents.resume({ resumeSessionId: SessionId(run.started.id) })
        try {
          handle.agent.session.append('research/finished', {
            phase: 'interrupted', finishedAt: Date.now(), reason: 'provider restarted before run completed',
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
    await this.mutation
    await Promise.all([...this.live].map(([id, handle]) => this.disposeRun(id, handle)))
  }
}

export default LocalResearchService
