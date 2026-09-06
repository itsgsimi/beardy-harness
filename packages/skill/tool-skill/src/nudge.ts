/**
 * Per-turn tool-call tally and the `skill_manage` nudge: when a turn settles
 * after enough tool calls without touching `skill_manage`, one logged notice is
 * injected for the next admitted request. Rationale lives in the skill-nudge
 * Agent Note.
 * @module @deepseek-ai/dsh-tool-skill/nudge
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** One agent's current-turn tally; created on first observed tool call. */
interface TurnTally {
  toolCalls: number
  skillManaged: boolean
}

/** The fixed nudge text, naming the completed call count. */
function nudgeText(toolCalls: number): string {
  return `This turn used ${String(toolCalls)} tool calls. If the procedure is reusable, `
    + 'save it as a skill with `skill_manage`; if it was one-off, ignore this.'
}

/**
 * Install the nudge listeners: count completed tool calls per Agent through the
 * post-execute chain, and inject the notice when a turn stops at or above the
 * threshold without a `skill_manage` call. The tally is consumed at the stop, so
 * every turn starts fresh; no notice lands unless one was owed.
 * @param ctx - plugin context; listeners are disposed with the fiber.
 * @param threshold - tool calls that trigger the notice; installation itself is the caller's decision.
 */
export function installSkillNudge(ctx: Context, threshold: number): void {
  const tallies = new WeakMap<Agent, TurnTally>()

  ctx.effect(() => {
    const stopCounting = ctx.on('tools/post-execute', async (exec, _result, next) => {
      const decision = await next()
      if (exec.agent !== undefined) {
        const tally = tallies.get(exec.agent) ?? { toolCalls: 0, skillManaged: false }
        tally.toolCalls += 1
        if (exec.name === 'skill_manage') tally.skillManaged = true
        tallies.set(exec.agent, tally)
      }
      return decision
    })
    const stopStopping = ctx.on('agent/turn-stopping', ({ agent }) => {
      const tally = tallies.get(agent)
      if (tally === undefined) return
      tallies.delete(agent)
      if (tally.skillManaged || tally.toolCalls < threshold) return
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: nudgeText(tally.toolCalls) }],
        source: {
          kind: 'skill-nudge',
          toolCalls: tally.toolCalls,
          form: 'notice',
          summary: `${String(tally.toolCalls)} tool calls without a skill`,
        },
      }))
    })
    return () => {
      stopCounting()
      stopStopping()
    }
  }, 'tool-skill.skill-nudge()')
}
