/**
 * Exact adapter-backed model choices shared by unattended Session entry points.
 * @module @deepseek-ai/dsh-unattended-session/model-selection
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

/** Deployment-owned exact route and optional adapter-owned effort. */
export interface ConfiguredModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string | undefined
}

/**
 * Validate an explicit lane choice against the registered adapter before any Session opens.
 * @param ctx - Context with the LLM registry.
 * @param choice - Deployment-supplied exact route and effort.
 * @param subject - Config field named in failures.
 * @returns Detached Agent selection.
 */
export async function validateModelSelection(
  ctx: Context, choice: ConfiguredModelSelection, subject: string,
): Promise<ModelSelection> {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error(`${subject}: an LLM registry is required to validate modelSelection`)
  let info: Awaited<ReturnType<typeof llm.resolveModelInfo>>
  try {
    info = await llm.resolveModelInfo(choice.provider, choice.model)
  } catch (error: unknown) {
    throw new Error(`${subject}: provider "${choice.provider}" model "${choice.model}" cannot be resolved`, { cause: error })
  }
  if (choice.reasoningEffort !== undefined
    && !info.reasoning?.efforts.some(effort => effort.id === choice.reasoningEffort)) {
    throw new Error(`${subject}: provider "${choice.provider}" model "${choice.model}" does not support reasoning effort "${choice.reasoningEffort}"`)
  }
  return {
    provider: choice.provider, model: choice.model,
    ...choice.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(choice.reasoningEffort) },
  }
}
