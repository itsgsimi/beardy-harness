// @vitest-environment jsdom
/** Research selection follows the profile form and writes only the worker field. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { bindSnapshotSelector, makeTranslate, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { ResearchCard } from '../src/client/ResearchCard.tsx'
import { ResearchCardController, type ResearchCardFace, type ResearchSettings } from '../src/client/research-card-controller.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const unused = (): never => { throw new Error('ResearchCard does not use this slot fixture') }
const standard: GlobalStandardProps = {
  usePanelInfo: unused, useSessions: unused, useSessionStatus: unused,
  useSessionRetainInfo: unused, useResource: unused, useWorkspaces: unused,
}
function renderCard(face: ResearchCardFace) {
  render(<ResearchCard {...{
    ...standard, ...face, t: makeTranslate(en, commonEn),
    useResearchCard: bindSnapshotSelector(face.hooks.researchCard),
  }} />)
}

it('shows configured research workers and saves the selected worker', async () => {
  const form = stubConfigForm<ResearchSettings>()
  form.publish({ status: 'ready', writable: true, value: {
    model: 'qwen4b', workerLabel: 'Local 4B', workers: [{ id: 'flash', label: 'Flash', model: 'flash' }],
  }, revision: 2 })
  renderCard(new ResearchCardController(form.scope).inject())
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['Local 4B', 'Flash'])
  await act(async () => {
    fireEvent.change(screen.getByRole('combobox', { name: en['settings.model'] }), { target: { value: 'flash' } })
  })
  expect(form.set).toHaveBeenCalledWith('selectedWorker', 'flash')
})

it('follows the profile form from loading through unavailable to its default model', () => {
  const form = stubConfigForm<ResearchSettings>()
  renderCard(new ResearchCardController(form.scope).inject())
  expect(screen.getByText(en['settings.loading'])).toBeTruthy()
  act(() => { form.publish({ status: 'unavailable' }) })
  expect(screen.getByText(en['settings.unavailable'])).toBeTruthy()
  act(() => { form.publish({ status: 'ready', writable: true, value: { model: 'qwen4b' }, revision: 1 }) })
  const picker = screen.getByRole<HTMLSelectElement>('combobox', { name: en['settings.model'] })
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['qwen4b'])
  expect(picker.value).toBe('default')
})

it('alerts when the profile refuses or fails the worker save and clears the alert on success', async () => {
  const form = stubConfigForm<ResearchSettings>()
  form.publish({ status: 'ready', writable: true, value: {
    model: 'qwen4b', workers: [{ id: 'flash', label: 'Flash', model: 'flash' }],
  }, revision: 1 })
  renderCard(new ResearchCardController(form.scope).inject())
  const choose = async (id: string) => {
    await act(async () => {
      fireEvent.change(screen.getByRole('combobox', { name: en['settings.model'] }), { target: { value: id } })
    })
  }
  form.set.mockResolvedValueOnce(false)
  await choose('flash')
  expect(screen.getByRole('alert').textContent).toBe(en['settings.saveFailed'])
  await choose('flash')
  expect(screen.queryByRole('alert')).toBeNull()
  form.set.mockRejectedValueOnce(new Error('profile write failed'))
  await choose('flash')
  expect(screen.getByRole('alert').textContent).toBe(en['settings.saveFailed'])
  expect(screen.getByRole<HTMLSelectElement>('combobox', { name: en['settings.model'] }).disabled).toBe(false)
})
