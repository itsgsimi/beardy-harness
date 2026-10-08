/**
 * `defineTool` output declaration shared by Beardy tools whose whole result is one text string.
 * @module @deepseek-ai/dsh-text-tool-output
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { InferValue } from '@deepseek-ai/dsh-tools'

const TEXT_TOOL_OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } },
} as const

/**
 * `defineTool` output declaration for a tool whose canonical value is `{ text }`, one required string
 * that the model receives as a single text part.
 */
export const TEXT_TOOL_OUTPUT: {
  readonly schema: typeof TEXT_TOOL_OUTPUT_SCHEMA
  render(args: unknown, value: InferValue<typeof TEXT_TOOL_OUTPUT_SCHEMA>): ContentBlock[]
} = {
  schema: TEXT_TOOL_OUTPUT_SCHEMA,
  render: (_args, value) => [{ type: 'text', text: value.text }],
}
