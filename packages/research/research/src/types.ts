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

/** Bounded engine settings frozen into each run's first durable event. */
export interface ResearchBudgets {
  readonly maxRounds: number
  readonly minRounds: number
  readonly firstRoundQueries: number
  readonly laterRoundQueries: number
  readonly searchResultsPerQuery: number
  readonly maxPagesPerRound: number
  readonly maxTotalPages: number
  readonly maxPageChars: number
  readonly maxFindingsInSynthesis: number
  readonly maxConcurrentSearches: number
  readonly maxConcurrentFetches: number
  readonly maxConcurrentModelCalls: number
  readonly softRunTimeoutMs: number
  readonly hardRunTimeoutMs: number
  readonly stageTimeoutMs: number
  readonly planMaxTokens: number
  readonly queryMaxTokens: number
  readonly extractMaxTokens: number
  readonly reportMaxTokens: number
  readonly maxEmptyRounds: number
  readonly reportPageChars: number
  readonly maxReportBytes: number
  readonly maxEvidenceBytes: number
}

/** Report format of the provider's general research workflow. */
export type ResearchCategory = 'general' | 'product' | 'comparison' | 'howto' | 'factcheck'

/** One fetched source with its immutable source-text attachment. */
export interface ResearchSource {
  readonly url: string
  readonly title: string
  readonly retrievedAt: number
  readonly contentSha256: string
  readonly content: FileAttachmentRef
  readonly truncated: boolean
  readonly requestedUrl?: string
  readonly statusCode?: number
}

/** Search outcome committed before its URLs enter the visited ledger. */
export interface ResearchSearch {
  readonly round: number
  readonly query: string
  readonly status: 'ok' | 'error'
  readonly urls: readonly string[]
  readonly reason?: string
}

/** Fetch outcome committed before extraction or another fetch attempt. */
export interface ResearchSourceAttempt {
  readonly round: number
  readonly requestedUrl: string
  readonly status: 'fetched' | 'http_error' | 'error'
  readonly finalUrl?: string
  readonly statusCode?: number
  readonly retrievedAt: number
  readonly source?: ResearchSource
  readonly reason?: string
}

/** Normalized model extraction; the child Session retains the raw answer. */
export interface ResearchFinding {
  readonly round: number
  readonly url: string
  readonly accepted: boolean
  readonly rational?: string
  readonly evidence?: string
  readonly summary?: string
  readonly reason?: string
}

/** A completed or explicitly partial report backed by immutable files. */
export interface ResearchReport {
  readonly runId: ResearchRunId
  readonly complete: boolean
  readonly markdown: string
  readonly sources: readonly ResearchSource[]
  /** Unicode characters per model-facing report page, captured when the run started. */
  readonly pageChars: number
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
  readonly reasoningEffort?: string
  readonly category?: ResearchCategory
  /** Consumer-supplied workflow name; absent for the provider's general workflow. */
  readonly workflow?: string
  readonly promptVersion?: string
  readonly budgets?: ResearchBudgets
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
  readonly queries?: readonly string[]
  readonly urls?: readonly string[]
  readonly stopReason?: string
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

/** A fetched page that a consumer workflow keeps as a cited source. */
export interface ResearchWorkflowPage {
  /** Workflow step that fetched the page. */
  readonly round: number
  /** URL passed to the fetch. */
  readonly requestedUrl: string
  /** Final URL after redirects. */
  readonly url: string
  /** Display title for citations. */
  readonly title: string
  /** HTTP status of the successful fetch. */
  readonly statusCode: number
  /** Epoch milliseconds when the fetch started. */
  readonly retrievedAt: number
  /** Exact text the workflow may show a model; saved unchanged as the source attachment. */
  readonly text: string
  /** Whether the fetch or text bound removed page content. */
  readonly truncated: boolean
}

/** A completed consumer workflow report. */
export interface ResearchWorkflowResult {
  /** Report Markdown saved as the immutable report file. */
  readonly markdown: string
  /** Evidence manifest JSON saved as the immutable evidence file. */
  readonly evidence: string
  /** Citation quality recorded in the terminal event. */
  readonly quality: 'verified_urls' | 'partial'
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Run creation in the run Session. */
    'research/started': ResearchStarted
    /** Caller Session's durable reference to a research run. */
    'research/linked': ResearchLinked
    /** Progress and immutable evidence references in the run Session. */
    'research/checkpoint': ResearchCheckpoint
    /** Search result ledger in the run Session. */
    'research/search': ResearchSearch
    /** Fetch outcome ledger in the run Session. */
    'research/source': ResearchSourceAttempt
    /** Accepted or rejected normalized extraction in the run Session. */
    'research/finding': ResearchFinding
    /** First terminal event wins; readers reject later terminal changes. */
    'research/finished': ResearchFinished
  }
}
