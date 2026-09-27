/** Research Service Definition (`ctx.research`). @module @deepseek-ai/dsh-research */

import { Context, Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ResearchCategory, ResearchOwner, ResearchReport, ResearchRunId, ResearchRunView } from './types.ts'

export type * from './types.ts'

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

/** Start input whose authority is derived by a trusted consumer. */
export interface ResearchStart {
  readonly caller: Session
  readonly owner: ResearchOwner
  readonly query: string
  readonly requestKey?: string
  readonly category?: ResearchCategory | 'fantasy_football'
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
   * Commit a run Session, then link and flush the caller Session before returning.
   * @param request - live caller, trusted owner, question, and optional exact-call idempotency key.
   * @returns the durable run view; duplicate keys return the same run.
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
