/** Durable turn facts for the optional skill capture notice. @module @deepseek-ai/dsh-tool-skill-manage/nudge */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

/** Host-only state rebuilt from the Session log when an Agent resumes. */
interface SkillNudgeState {
  calls: number
  loaded: boolean
  pendingSkillCalls: string[]
  completedTurn: number
  completedCalls: number
  completedLoaded: boolean
  nudged: boolean
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    skillNudge: SkillNudgeState
  }
}

const stateSchema = z.object({
  calls: z.number().int().nonnegative(),
  loaded: z.boolean(),
  pendingSkillCalls: z.array(z.string()),
  completedTurn: z.number().int().nonnegative(),
  completedCalls: z.number().int().nonnegative(),
  completedLoaded: z.boolean(),
  nudged: z.boolean(),
}).strict()

/** A completed result counts once; a model or user skill load suppresses the turn's notice. */
export const skillNudgeProjection: ProjectionDefinition<'skillNudge'> = {
  key: 'skillNudge',
  stateVersion: 2,
  stateSchema,
  init: () => ({
    calls: 0, loaded: false, pendingSkillCalls: [], completedTurn: 0,
    completedCalls: 0, completedLoaded: false, nudged: false,
  }),
  apply(state, event) {
    switch (event.type) {
      case 'turn/start':
        return { ...state, calls: 0, loaded: false, pendingSkillCalls: [] }
      case 'tool/call':
        return event.data.name === 'skill'
          ? { ...state, pendingSkillCalls: [...state.pendingSkillCalls, event.data.callId] } : state
      case 'tool/result': {
        const callId = event.data.message.toolCallId
        const pendingSkillCalls = state.pendingSkillCalls.filter(id => id !== callId)
        return {
          ...state,
          calls: state.calls + 1,
          loaded: state.loaded || !event.data.message.isError && pendingSkillCalls.length !== state.pendingSkillCalls.length,
          pendingSkillCalls,
        }
      }
      case 'user/message':
        if (event.data.source.kind === 'skill-nudge') return { ...state, nudged: true }
        return event.data.source.kind === 'skill-invocation' ? { ...state, loaded: true } : state
      case 'turn/end':
        return event.data.reason.kind === 'completed'
          ? { ...state, completedTurn: event.data.turn, completedCalls: state.calls, completedLoaded: state.loaded }
          : { ...state, completedTurn: event.data.turn, completedCalls: 0, completedLoaded: state.loaded }
      default:
        return state
    }
  },
}

/**
 * Add at most one notice in a Session, on the first request after an eligible completed turn.
 * @param ctx - context carrying the Session projection and agent events.
 * @param threshold - minimum completed tool results in an eligible turn.
 */
export function installSkillNudge(ctx: Context, threshold: number): void {
  ctx.sessionProjections.register(skillNudgeProjection)
  ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || agent.session.header.origin === 'subagent') return decision
    const state = ctx.sessionProjections.stateOf(agent.session, 'skillNudge')
    if (state === undefined || state.nudged || state.completedTurn >= turn
      || state.completedCalls < threshold || state.completedLoaded) return decision
    const calls = state.completedCalls
    const callLabel = `${String(calls)} tool call${calls === 1 ? '' : 's'}`
    return { ...decision, messages: [...decision.messages, createUserMessage({
      content: [{ type: 'text', text: `The last turn used ${callLabel}. If its procedure is reusable, save it as a skill with \`skill_manage\`; otherwise ignore this.` }],
      source: { kind: 'skill-nudge', toolCalls: calls, form: 'notice', summary: `${callLabel} without a skill` },
    })] }
  })
}
