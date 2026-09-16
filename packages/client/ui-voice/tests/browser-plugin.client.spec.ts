import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

it('waits for the composer slot and removes its contribution on unload', async () => {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('sessions', { scope: () => undefined })
  ctx.provide('conversation', { input: { for: vi.fn() } })
  const fiber = ctx.plugin({ inject, apply })
  await fiber.await()
  expect(ctx.slots.entries('conversation.input.right')).toHaveLength(0)
  ctx.slots.register({ name: 'root', children: {
    'conversation.input.right': { kind: 'list', scope: 'session' },
  } } as never, () => null)
  await Promise.resolve()
  expect(ctx.slots.entries('conversation.input.right')).toHaveLength(1)
  await fiber.dispose()
  expect(ctx.slots.entries('conversation.input.right')).toHaveLength(0)
  await ctx.fiber.dispose()
})
