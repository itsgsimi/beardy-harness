/** What the browser half registers, and that it all leaves with the fiber. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as hostApply, name } from '../src/index.ts'
import { Visuals } from '../src/client/Visuals.tsx'
import { visualsDefinition } from '../src/client/visuals.ts'

it('marks the host roster without host behavior', () => {
  expect(name).toBe('client-ui-visuals')
  expect(() => { hostApply() }).not.toThrow()
})

it('registers the node definition and the presented-visual Chat node view for the fiber lifetime', async () => {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const disposeDefinition = vi.fn()
  const register = vi.fn(() => disposeDefinition)
  ctx.provide('uiConversation', { events: { register } } as never)
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } } } as never, () => null)

  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  expect(inject).toEqual(['slots', 'locale', 'uiConversation'])
  expect(register).toHaveBeenCalledWith(visualsDefinition)
  expect(slots.entries('conversation.chat.node').map(entry => [entry.options.key, entry.component])).toEqual([['presented-visual', Visuals]])
  expect(ctx.get('locale')?.bind('visuals')('visual.expand')).toBe('Expand view')

  await fiber.dispose()
  expect(slots.entries('conversation.chat.node')).toHaveLength(0)
})
