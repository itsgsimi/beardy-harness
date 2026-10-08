/**
 * Agent-scoped prompt isolation for single-purpose model turns that must answer from one dedicated
 * system prompt with no tools.
 * @module @deepseek-ai/dsh-dedicated-prompt
 */

import type { Context } from '@deepseek-ai/cordis'
import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent'

/** The prompt and sampling an isolated Agent scope sends on every request. */
export interface DedicatedPrompt {
  /** Complete system prompt; every other prompt section and the runtime context are left out. */
  readonly systemPrompt: string
  /** Sampling temperature of every request; the logged request header carries it. */
  readonly temperature: number
}

/**
 * Make one Agent scope answer from a dedicated complete system prompt. The scope's section shadows the
 * deployment persona prefix as the complete prompt, so no other section reaches the model; runtime
 * context is suppressed; prompt assembly drops every tool schema, including schemas of tools other
 * plugins register in the scope later; and every request carries `temperature`. Tool execution is not
 * guarded here: the caller installs its own `tools.guard` with its own refusal text.
 * @param agentCtx - the Agent's own scoped context, normally from `ctx.agents.create({ setup })`.
 * @param prompt - complete system prompt text, used verbatim, and the request temperature.
 * @returns disposer for every contribution.
 */
export function installDedicatedPrompt(agentCtx: Context, prompt: DedicatedPrompt): () => void {
  const disposers = [
    agentCtx.systemPrompt.section({
      name: PERSONA_PREFIX_SECTION,
      order: agentCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      text: prompt.systemPrompt,
      interpolate: false,
      complete: true,
    }),
    agentCtx.systemPrompt.suppressRuntimeContext(),
    agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => ({ ...await next(), tools: [] })),
    agentCtx.on('agent/request', async (_payload, next) => ({ ...await next(), temperature: prompt.temperature })),
  ]
  return () => { for (const dispose of disposers) dispose() }
}
