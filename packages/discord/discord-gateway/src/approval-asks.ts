/**
 * Undecided approval questions folded from each Session's `approval/asked` and `approval/decided`
 * audit events, so the gateway can name a Discord approval prompt after the logged request id.
 * @module @deepseek-ai/dsh-discord-gateway/approval-asks
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { ApprovalRequestId, type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { z } from 'zod'

/** One logged question whose `approval/decided` has not been appended yet. */
interface UndecidedApproval {
  readonly id: string
  readonly toolName: string
  readonly callId?: string | undefined
  readonly reason?: string | undefined
}

/** Host-only state: undecided questions in append order. */
interface ApprovalAsksState {
  readonly undecided: readonly UndecidedApproval[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    discordApprovalAsks: ApprovalAsksState
  }
}

const stateSchema = z.object({
  undecided: z.array(z.object({
    id: z.string(),
    toolName: z.string(),
    callId: z.string().optional(),
    reason: z.string().optional(),
  }).strict()),
}).strict()

/** Folds the approval audit pair into the questions still waiting for an outcome. */
export const approvalAsksProjection: ProjectionDefinition<'discordApprovalAsks'> = {
  key: 'discordApprovalAsks',
  stateVersion: 1,
  stateSchema,
  init: () => ({ undecided: [] }),
  apply(state, event) {
    switch (event.type) {
      case 'approval/asked': {
        const { id, toolName, callId, reason } = event.data
        const ask = { id, toolName, ...callId === undefined ? {} : { callId }, ...reason === undefined ? {} : { reason } }
        return { undecided: [...state.undecided, ask] }
      }
      case 'approval/decided':
        return { undecided: state.undecided.filter(ask => ask.id !== event.data.id) }
      default:
        return state
    }
  },
}

/**
 * Claims the logged id of the undecided question that one dispatched request put to the answerer
 * chain. The approval service appends `approval/asked` before it dispatches `approval/request`, in
 * the same order, so a request that reached this answerer through the service has a matching
 * undecided question in its Session. Each call claims the earliest matching question not claimed
 * before; a claim lasts until the question's `approval/decided` leaves the fold.
 */
export class ApprovalIdClaims {
  private readonly claims = new WeakMap<Session, Set<string>>()

  /**
   * @param ctx - context whose optional `sessionProjections` service holds the fold.
   */
  constructor(private readonly ctx: Context) {}

  /**
   * Claim the logged id for one request.
   * @param req - the dispatched approval request.
   * @returns the logged id, or undefined for a request dispatched without an audit event.
   */
  claim(req: ApprovalRequest): ApprovalRequestId | undefined {
    const session = req.agent.session
    const undecided = this.ctx.get('sessionProjections')?.stateOf(session, 'discordApprovalAsks')?.undecided ?? []
    const live = new Set(undecided.map(ask => ask.id))
    const claimed = new Set([...this.claims.get(session) ?? []].filter(id => live.has(id)))
    const match = undecided.find(ask => !claimed.has(ask.id) && ask.toolName === req.toolName
      && ask.callId === req.callId && ask.reason === req.reason)
    if (match !== undefined) claimed.add(match.id)
    this.claims.set(session, claimed)
    return match === undefined ? undefined : ApprovalRequestId(match.id)
  }
}
