/** What the browser half registers, and that it all leaves with the fiber. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject, RESEARCH_TOOL_NAMES } from '../src/client/index.ts'
import { apply as hostApply, name } from '../src/index.ts'
import type { ResearchCardFace, ResearchSettings } from '../src/client/research-card-controller.ts'
import { ResearchRow } from '../src/client/ResearchRow.tsx'
import { ResearchCard } from '../src/client/ResearchCard.tsx'

async function bench() {
  const form = stubConfigForm<ResearchSettings>()
  const getConfigForm = vi.fn((_namespace: string) => form.scope)
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  ctx.provide('configForms', { get: getConfigForm } as never)
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: {
    'tool.call.toolview': { kind: 'keyed', scope: 'session' },
    'settings.plugins.tab': { kind: 'list', scope: 'root' },
  } } as never, () => null)
  return { ctx, slots, form, getConfigForm }
}

it('marks the host roster without host behavior', () => {
  expect(name).toBe('client-ui-research')
  expect(() => { hostApply() }).not.toThrow()
})

it('registers both research tool views and the research Settings tab bound to the profile form', async () => {
  const { ctx, slots, form, getConfigForm } = await bench()
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()

  expect(inject).toEqual(['slots', 'locale', 'configForms'])
  expect(slots.entries('tool.call.toolview').map(entry => [entry.options.key, entry.component]))
    .toEqual(RESEARCH_TOOL_NAMES.map(key => [key, ResearchRow]))
  const [tab] = slots.entries('settings.plugins.tab')
  expect(tab?.component).toBe(ResearchCard)
  expect(tab?.options).toMatchObject({ id: 'research', order: 20 })
  expect(resolveSlotLabel(tab!.options.label)).toBe('深度研究')
  expect(getConfigForm).toHaveBeenCalledWith('odysseus-research')

  const face = (tab!.inject as () => Pick<ResearchCardFace, 'hooks' | 'selectWorker'>)()
  form.publish({ status: 'ready', writable: true, value: { model: 'qwen4b', workerLabel: 'Local 4B' }, revision: 1 })
  expect(face.hooks.researchCard.getSnapshot()).toMatchObject({ status: 'ready', selected: 'default', choices: [{ id: 'default', label: 'Local 4B' }] })
  await face.selectWorker('default')
  expect(form.set).toHaveBeenCalledWith('selectedWorker', 'default')

  await fiber.dispose()
  expect(slots.entries('tool.call.toolview')).toHaveLength(0)
  expect(slots.entries('settings.plugins.tab')).toHaveLength(0)
})
