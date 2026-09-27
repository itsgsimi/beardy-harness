/** Durable research run types and Session events. @module @deepseek-ai/dsh-research/types */

import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Identity shared by a research run and its authoritative Session. */
export type ResearchRunId = Branded<'ResearchRunId'>

/** Authority chosen by a trusted caller, never by model arguments. */
export type ResearchOwner =
  | { readonly kind: 'session'; readonly sessionId: SessionId }
  | { readonly kind: 'profile'; readonly namespace: string }

/** Durable lifecycle phase of a run. */
export type ResearchPhase = 'running' | 'completed' | 'cancelled' | 'interrupted' | 'budget_exhausted' | 'failed'

/** One fetched source with its immutable source-text attachment. */
export interface ResearchSource {
  readonly url: string
  readonly title: string
  readonly retrievedAt: number
  readonly contentSha256: string
  readonly content: FileAttachmentRef
  readonly truncated: boolean
}

/** A completed or explicitly partial report backed by immutable files. */
export interface ResearchReport {
  readonly runId: ResearchRunId
  readonly complete: boolean
  readonly markdown: string
  readonly sources: readonly ResearchSource[]
  readonly reportRef: FileAttachmentRef
  readonly evidenceRef: FileAttachmentRef
}

/** Run state projected from committed `research/*` events. */
export interface ResearchRunView {
  readonly id: ResearchRunId
  readonly owner: ResearchOwner
  readonly callerSessionId: SessionId
  readonly query: string
  readonly phase: ResearchPhase
  readonly round: number
  readonly stageSessionIds: readonly SessionId[]
  readonly sourceCount: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly provider: string
  readonly model: string
  readonly reportAvailable: boolean
  readonly reason?: string
}

/** Durable run creation, committed before caller linkage or work starts. */
export interface ResearchStarted {
  readonly id: ResearchRunId
  readonly owner: ResearchOwner
  readonly callerSessionId: SessionId
  readonly query: string
  readonly requestKey?: string
  readonly provider: string
  readonly model: string
  readonly createdAt: number
}

/** Caller-side reference to an already durable run. */
export interface ResearchLinked {
  readonly id: ResearchRunId
}

/** One durable progress boundary; a stage ID names a child Session. */
export interface ResearchCheckpoint {
  readonly round: number
  readonly stageSessionId?: SessionId
  readonly source?: ResearchSource
  readonly draftRef?: FileAttachmentRef
  readonly elapsedMs: number
}

/** Terminal state: completion requires both precommitted files; other phases may retain both or neither. */
export interface ResearchFinished {
  readonly phase: Exclude<ResearchPhase, 'running'>
  readonly finishedAt: number
  readonly reason?: string
  readonly reportRef?: FileAttachmentRef
  readonly evidenceRef?: FileAttachmentRef
  readonly quality?: 'verified_urls' | 'partial' | 'source_unavailable'
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Run creation in the run Session. */
    'research/started': ResearchStarted
    /** Caller Session's durable reference to a research run. */
    'research/linked': ResearchLinked
    /** Progress and immutable evidence references in the run Session. */
    'research/checkpoint': ResearchCheckpoint
    /** First terminal event wins; readers reject later terminal changes. */
    'research/finished': ResearchFinished
  }
}
