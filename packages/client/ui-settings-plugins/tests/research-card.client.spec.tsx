// @vitest-environment jsdom
/** Research model changes are staged and saved through the settings scope. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { bindSnapshotSelector, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { ResearchCard } from '../src/client/ResearchCard.tsx'
import type { ResearchCardProps } from '../src/client/ResearchCard.tsx'
import { ResearchCardController, type ResearchSettings } from '../src/client/research-card-controller.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

it('shows configured research models and writes only the selected worker on save', async () => {
  const settings: ResearchSettings = { worker: 'default', choices: [
    { id: 'default', label: 'Local 4B', model: 'qwen4b' }, { id: 'flash', label: 'Flash', model: 'flash' },
  ] }
  const host = stubSettingsScope<ResearchSettings>()
  host.publish({ status: 'ready', writable: true, value: settings, revision: 2 })
  const face = new ResearchCardController(host.scope).inject()
  const props = {
    ...face,
    t: (key: keyof typeof en) => en[key],
    useResearchCard: bindSnapshotSelector(face.hooks.researchCard),
  } as unknown as ResearchCardProps
  render(<ResearchCard {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Show settings: Deep research' }))
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['Local 4B', 'Flash'])
  fireEvent.change(screen.getByRole('combobox', { name: 'Research model' }), { target: { value: 'flash' } })
  expect(host.set).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
  await expect.poll(() => host.set.mock.calls).toEqual([['worker', 'flash']])
})
