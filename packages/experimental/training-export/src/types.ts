/**
 * On-disk vocabulary for the `dsh-training-export` sidecar. Contract source:
 * `docs/training-export-format.md` in the halorun checkout (version 1; both
 * this writer and the `halorun dataset` reader validate `version` and refuse
 * anything else).
 * @module @deepseek-ai/dsh-experimental-training-export/types
 */

import type {
  ContentBlock, FinishReason, GenerateOptions, TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { MessageFeedbackRating } from '@deepseek-ai/dsh-message-feedback'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** `meta.json`, written once per session directory at its first sample. */
export interface TrainingExportMeta {
  readonly version: 1
  readonly sessionId: SessionId
  readonly parentSessionId: SessionId | null
  readonly delegationDepth: number
  readonly cwd?: string
  readonly createdAt: number
  /** Harness identity: `dsh-<dsh-session package version>`. */
  readonly harness: string
  /** This plugin's own `<npm name>/<version>`. */
  readonly plugin: string
}

/** `GenerateOptions` as sent to the adapter, minus the two fields the spec excludes. */
export type TrainingSampleRequest =
  & Omit<GenerateOptions, 'purpose' | 'sessionId' | 'signal'>
  & { readonly purpose: 'compaction' | 'session-title' | null }

/** Normalized failure recorded on a sample whose call aborted or errored. */
export interface TrainingSampleError {
  readonly name: string
  readonly message: string
  readonly code?: string
}

/** Folded `llm/stream` output for one model call. */
export interface TrainingSampleResponse {
  /** `block-end` blocks, in index order. */
  readonly content: ContentBlock[]
  readonly finish: FinishReason | null
  readonly usage: TokenUsage | null
  readonly error: TrainingSampleError | null
}

/** SHA-256 digests (`sha256:<hex>`) over the request's stable, redaction-relevant fields. */
export interface TrainingSampleHashes {
  /** Over the UTF-8 `system` string (empty string when absent). */
  readonly system: string
  /** Over the canonical (sorted-key, no-whitespace) JSON of `tools` (`[]` when absent). */
  readonly tools: string
}

/** Workspace identity captured once per turn for an allow-listed provider's first sample. */
export interface TrainingWorkspaceSnapshot {
  readonly cwd: string
  /** `git rev-parse HEAD`; `null` on failure or outside a repository. */
  readonly head: string | null
  /** Whether `git status --porcelain` reported any change; `null` when `head` is `null`. */
  readonly dirty: boolean | null
}

/** `train/sample` — one line per `llm/stream` call whose `sessionId` is set. */
export interface TrainingSampleLine {
  readonly version: 1
  readonly kind: 'sample'
  /** Per-session monotonic counter (this plugin's own, not the session log's). */
  readonly seq: number
  readonly turn: number | null
  readonly step: number | null
  readonly purpose: 'compaction' | 'session-title' | null
  readonly at: number
  readonly request: TrainingSampleRequest
  readonly response: TrainingSampleResponse
  readonly hashes: TrainingSampleHashes
  readonly workspace: TrainingWorkspaceSnapshot | null
}

/** One `hook/result` folded into a label. */
export interface TrainingHookOutcome {
  readonly name: string
  /** Whether the hook's exit code was exactly zero. */
  readonly ok: boolean
  readonly exitCode?: number
}

/** Approval counts for one turn. */
export interface TrainingApprovalCounts {
  readonly asked: number
  readonly approved: number
  readonly rejected: number
}

/** `git diff --shortstat` against the turn's captured workspace head. */
export interface TrainingDiffStat {
  readonly files: number
  readonly insertions: number
  readonly deletions: number
}

/** One rating joined from `dsh-message-feedback` for an assistant message produced in the turn. */
export interface TrainingRatingEntry {
  readonly messageId: MessageId
  readonly rating: MessageFeedbackRating
  readonly note: string
}

/** `train/label` — one line per `turn/end`. */
export interface TrainingLabelLine {
  readonly version: 1
  readonly kind: 'label'
  readonly turn: number
  readonly at: number
  readonly completed: boolean
  /** `turn/end.reason.kind`, verbatim. */
  readonly finishReason: string
  readonly steps: number
  /** `seq` of every `train/sample` line written during this turn, ascending. */
  readonly samples: number[]
  readonly toolCalls: number
  readonly toolErrors: number
  readonly hooks: TrainingHookOutcome[]
  readonly approvals: TrainingApprovalCounts
  readonly diff: TrainingDiffStat | null
  readonly ratings: TrainingRatingEntry[]
  readonly compactionInTurn: boolean
}
