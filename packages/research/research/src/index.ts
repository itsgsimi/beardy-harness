/** Research Service Definition (`ctx.research`). @module @deepseek-ai/dsh-research */

import { Context, Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Session } from '@deepseek-ai/dsh-session'
import type {
  ResearchBudgets, ResearchCategory, ResearchFinding, ResearchOwner, ResearchReport, ResearchRunId, ResearchRunView,
  ResearchSearch, ResearchSource, ResearchSourceAttempt, ResearchWorkflowPage, ResearchWorkflowResult,
} from './types.ts'

export type * from './types.ts'
export { paginateResearchResponse, researchPageOutput, researchPageOutputSchema } from './page.ts'
export type { ResearchPageArtifact, ResearchPageResponse } from './page.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A run view changed after its run Session passed the durability barrier.
     * @mode emit
     * @param payload - committed run view for a local observer.
     */
    'research/changed'(payload: { run: ResearchRunView }): void
  }
}

/**
 * Admit a serialized run identity at a trusted boundary.
 * @param id - persisted or newly allocated run id.
 * @returns branded identity.
 */
export function ResearchRunId(id: string): ResearchRunId {
  return brandString<ResearchRunId>(id)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    research: ResearchService
  }
}

/** Durable ledger writes and logged model stages available to a workflow inside its run. */
export interface ResearchWorkflowRun {
  /** Run identity; also the run Session ID. */
  readonly id: ResearchRunId
  /** Aborts on owner cancellation, provider shutdown, or the run's hard deadline. */
  readonly signal: AbortSignal
  /**
   * Run one tool-free model turn in a new child Session of the run, after committing its ID to the run.
   * The stage Session answers from the workflow's stage system prompt, or the provider's when the
   * workflow sets none, and sees no tools or runtime context.
   * @param prompt - exact user message; the child Session log reconstructs the request.
   * @param maxTokens - output ceiling for this stage.
   * @param options - sampling override and the JSON check that admits one corrective turn.
   * @returns settled, non-empty assistant text: the corrective answer when one ran and passed the check, otherwise the first answer.
   */
  stage(prompt: string, maxTokens: number, options?: ResearchStageOptions): Promise<string>
  /**
   * Commit one search outcome to the run.
   * @param result - query, status, and returned URLs.
   */
  search(result: ResearchSearch): Promise<void>
  /**
   * Save a page's exact text as an immutable attachment, then commit the fetch outcome.
   * @param page - fetched page and the text a model may read.
   * @returns the committed source with its attachment reference.
   */
  fetched(page: ResearchWorkflowPage): Promise<ResearchSource>
  /**
   * Commit one unsuccessful fetch outcome.
   * @param attempt - HTTP or transport failure without a source.
   */
  failed(attempt: Omit<ResearchSourceAttempt, 'status' | 'source'> & { readonly status: 'http_error' | 'error' }): Promise<void>
  /**
   * Commit whether a fetched page was admitted as evidence.
   * @param result - admission decision and optional reason.
   */
  finding(result: ResearchFinding): Promise<void>
}

/** Per-stage choices a workflow passes with one stage prompt. */
export interface ResearchStageOptions {
  /** Sampling temperature from 0 through 2 replacing the provider's configured stage temperature. */
  readonly temperature?: number
  /**
   * Whether an answer is the JSON the prompt asks for. A rejected first answer receives one corrective
   * `user/message` in the same stage Session, so the stage makes at most two model requests.
   * @param text - trimmed, non-empty answer text.
   * @returns true when the answer parses as the expected JSON shape.
   */
  readonly expectJson?: (text: string) => boolean
}

/**
 * A consumer-owned research procedure the provider executes inside one durable run. The provider
 * records the workflow name and prompt version at start and commits the resolved report as completed;
 * a rejection ends the run as failed with the error text as its reason.
 */
export interface ResearchWorkflow {
  /** Stable workflow name recorded in the run's start event. */
  readonly name: string
  /** Prompt template version recorded in the run's start event. */
  readonly promptVersion: string
  /** Run and stage deadlines replacing the provider's configured values for this run only. */
  readonly budgets?: Partial<Pick<ResearchBudgets, 'hardRunTimeoutMs' | 'stageTimeoutMs'>>
  /**
   * Complete system prompt of every stage Session of this run, replacing the provider's research stage
   * prompt; 1 to 4000 characters. Each stage Session logs it with its first request.
   */
  readonly stageSystemPrompt?: string
  /**
   * Execute the procedure.
   * @param run - ledger writes and logged model stages bound to the run.
   * @returns report and evidence to commit as the completed result.
   */
  run(run: ResearchWorkflowRun): Promise<ResearchWorkflowResult>
}

/** Start input whose authority is derived by a trusted consumer. */
export interface ResearchStart {
  readonly caller: Session
  readonly owner: ResearchOwner
  readonly query: string
  readonly requestKey?: string
  /** General report format; not combined with a workflow. */
  readonly category?: ResearchCategory
  /** Consumer procedure replacing the provider's general workflow for this run. */
  readonly workflow?: ResearchWorkflow
}

/** Owner-scoped listing input. */
export interface ResearchList {
  readonly owner: ResearchOwner
  readonly query?: string
  readonly limit: number
  readonly cursor?: ResearchRunId
}

/** Durable research lifecycle and report access. */
export abstract class ResearchService extends Service {
  constructor(ctx: Context) {
    if (new.target === ResearchService) throw new Error('load a research provider, not the abstract definition')
    super(ctx, 'research')
  }

  /**
   * Derive the configured run authority from a live caller Session.
   * @param caller - Session executing a trusted consumer action.
   * @returns caller-scoped or configured single-user profile authority.
   */
  abstract ownerFor(caller: Session): ResearchOwner

  /**
   * Commit a run Session, then link and flush the caller Session before returning.
   * @param request - live caller, trusted owner, question, optional exact-call idempotency key, and optional workflow.
   * @returns the durable run view; duplicate keys return the same run without starting another workflow.
   */
  abstract start(request: ResearchStart): Promise<ResearchRunView>

  /**
   * Read a run without revealing foreign or missing identities.
   * @param id - run identity.
   * @param owner - trusted reading authority.
   * @returns current durable view.
   */
  abstract status(id: ResearchRunId, owner: ResearchOwner): Promise<ResearchRunView>

  /**
   * Project stored run Sessions and return an owner-filtered page.
   * @param request - trusted owner and page selection.
   * @returns durable views, newest first.
   */
  abstract list(request: ResearchList): Promise<readonly ResearchRunView[]>

  /**
   * Verify immutable report files before exposing their contents.
   * @param id - run identity.
   * @param owner - trusted reading authority.
   * @returns completed or explicitly partial report.
   */
  abstract report(id: ResearchRunId, owner: ResearchOwner): Promise<ResearchReport>

  /**
   * Commit a cancellation request; the first terminal result remains authoritative.
   * @param id - run identity.
   * @param owner - trusted cancelling authority.
   * @returns whether this call requested cancellation.
   */
  abstract cancel(id: ResearchRunId, owner: ResearchOwner): Promise<{ requested: boolean }>
}

export default ResearchService
