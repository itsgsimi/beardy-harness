/**
 * Exact adapter-backed model choices shared by unattended Session entry points.
 * @module @deepseek-ai/dsh-unattended-session/model-selection
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

/** Deployment-owned exact route and optional adapter-owned effort. */
export interface ConfiguredModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string | undefined
}

/**
 * Loader schema for one `modelSelection` config field. It checks only the field shapes; entry points
 * pass the value to {@link validateModelSelection} to check it against the registered adapter.
 */
export const ConfiguredModelSelectionSchema: z<ConfiguredModelSelection> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  reasoningEffort: z.union([z.string(), z.const(undefined)]),
})

/**
 * Validate an explicit lane choice against the registered adapter when a Session opens.
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
