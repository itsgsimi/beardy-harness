import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import type { VoiceInjected } from '../src/client/VoiceControl.tsx'
import { apply as nodeApply } from '../src/index.ts'

function declareComposer(ctx: Context): void {
  ctx.slots.register({ name: 'root', children: {
    'conversation.input.right': { kind: 'list', scope: 'session' },
  } } as never, () => null)
}

it('waits for the composer slot and removes its contribution on unload', async () => {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('sessions', { scope: () => undefined })
  ctx.provide('conversation', { input: { for: vi.fn() } })
  const fiber = ctx.plugin({ inject, apply })
  await fiber.await()
  expect(ctx.slots.entries('conversation.input.right')).toHaveLength(0)
  declareComposer(ctx)
  await Promise.resolve()
  expect(ctx.slots.entries('conversation.input.right')).toHaveLength(1)
  await fiber.dispose()
  expect(ctx.slots.entries('conversation.input.right')).toHaveLength(0)
  await ctx.fiber.dispose()
})

it('appends a transcript only to the draft of a session that is still open', async () => {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const open = { id: 'open-scope' }
  ctx.provide('sessions', { scope: (id: SessionId) => id === SessionId('open') ? open : undefined })
  const appendDraft = vi.fn((_text: string) => true)
  const inputFor = vi.fn((_scope: unknown) => ({ appendDraft }))
  ctx.provide('conversation', { input: { for: inputFor } })
  declareComposer(ctx)
  await ctx.plugin({ inject, apply }).await()
  const entry = ctx.slots.entries('conversation.input.right')[0]!
  const injectFor = entry.inject as (sessionId: SessionId) => Pick<VoiceInjected, 'append'>
  expect(injectFor(SessionId('closed')).append('Late words.')).toBe(false)
  expect(inputFor).not.toHaveBeenCalled()
  expect(injectFor(SessionId('open')).append('Inspect the diff.')).toBe(true)
  expect(inputFor).toHaveBeenCalledWith(open)
  expect(appendDraft).toHaveBeenCalledWith('Inspect the diff.')
  await ctx.fiber.dispose()
})

describe('ui-voice node half', () => {
  it('keeps the host Loader entry inert', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
