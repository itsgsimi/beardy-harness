import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { ConfiguredModelSelectionSchema, validateModelSelection } from '../src/model-selection.ts'

describe('configured unattended model selection', () => {
  const ctx = new Context()
  ctx.provide('llm', {
    resolveModelInfo: async (provider: string, model: string) => {
      if (provider === 'missing') throw new Error('route unavailable')
      return { provider, id: model, name: model,
        reasoning: { efforts: [{ id: ReasoningEffortId('medium'), name: 'Medium' }] } }
    },
  } as never)

  it('accepts a supported exact route and effort', async () => {
    await expect(validateModelSelection(ctx, { provider: 'local', model: 'coder', reasoningEffort: 'medium' }, 'lane'))
      .resolves.toEqual({ provider: 'local', model: 'coder', reasoningEffort: 'medium' })
  })

  it('accepts an exact route without choosing an effort', async () => {
    await expect(validateModelSelection(ctx, { provider: 'local', model: 'coder' }, 'lane'))
      .resolves.toEqual({ provider: 'local', model: 'coder' })
  })

  it('requires a registry when an explicit choice is supplied', async () => {
    await expect(validateModelSelection(new Context(), { provider: 'local', model: 'coder' }, 'lane'))
      .rejects.toThrow('lane: an LLM registry is required to validate modelSelection')
  })

  it('rejects an unavailable route and an unsupported effort with the config field named', async () => {
    await expect(validateModelSelection(ctx, { provider: 'missing', model: 'coder' }, 'lane'))
      .rejects.toThrow('lane: provider "missing" model "coder" cannot be resolved')
    await expect(validateModelSelection(ctx, { provider: 'local', model: 'coder', reasoningEffort: 'high' }, 'lane'))
      .rejects.toThrow('lane: provider "local" model "coder" does not support reasoning effort "high"')
  })

  it('shapes the config field as an exact route with an optional effort', () => {
    expect(ConfiguredModelSelectionSchema({ provider: 'local', model: 'coder' })).toEqual({ provider: 'local', model: 'coder' })
    expect(ConfiguredModelSelectionSchema({ provider: 'local', model: 'coder', reasoningEffort: 'medium' }))
      .toEqual({ provider: 'local', model: 'coder', reasoningEffort: 'medium' })
    expect(() => ConfiguredModelSelectionSchema({ provider: 'local' } as never)).toThrow()
  })
})
