import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { TEXT_TOOL_OUTPUT } from '@deepseek-ai/dsh-text-tool-output'

describe('TEXT_TOOL_OUTPUT', () => {
  it('declares a text-only output whose one required string renders as one text part', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.tools.register(defineTool({
      name: 'text-output',
      description: 'text output',
      parameters: {},
      output: TEXT_TOOL_OUTPUT,
      execute: async () => ({ text: 'body' }),
    }))
    expect(ctx.tools.get('text-output')?.output.schema).toEqual({
      type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'],
    })
    const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('c1'), name: 'text-output', arguments: {} })
    expect(result).toEqual({ content: [{ type: 'text', text: 'body' }], isError: false, value: { text: 'body' } })
  })
})
