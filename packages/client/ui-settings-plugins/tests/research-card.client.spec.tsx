// @vitest-environment jsdom
/** Research selection follows the profile form and writes only the worker field. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { bindSnapshotSelector, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { ResearchCard } from '../src/client/ResearchCard.tsx'
import type { ResearchCardProps } from '../src/client/ResearchCard.tsx'
import { ResearchCardController, type ResearchSettings } from '../src/client/research-card-controller.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

it('shows configured research workers and saves the selected worker', async () => {
  const form = stubConfigForm<ResearchSettings>()
  form.publish({ status: 'ready', writable: true, value: {
    model: 'qwen4b', workerLabel: 'Local 4B', workers: [{ id: 'flash', label: 'Flash', model: 'flash' }],
  }, revision: 2 })
  const face = new ResearchCardController(form.scope).inject()
  render(<ResearchCard {...({
    ...face, t: (key: keyof typeof en) => en[key],
    useResearchCard: bindSnapshotSelector(face.hooks.researchCard),
  } as unknown as ResearchCardProps)} />)
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['Local 4B', 'Flash'])
  await act(async () => {
    fireEvent.change(screen.getByRole('combobox', { name: 'Research model' }), { target: { value: 'flash' } })
  })
  expect(form.set).toHaveBeenCalledWith('selectedWorker', 'flash')
})
