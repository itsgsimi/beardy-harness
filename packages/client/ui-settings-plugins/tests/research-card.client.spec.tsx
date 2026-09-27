// @vitest-environment jsdom
/** Research selection follows the profile form and writes only the worker field. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { bindSnapshotSelector, makeTranslate, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { ResearchCard } from '../src/client/ResearchCard.tsx'
import { ResearchCardController, type ResearchSettings } from '../src/client/research-card-controller.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const unused = (): never => { throw new Error('ResearchCard does not use this slot fixture') }
const standard: GlobalStandardProps = {
  usePanelInfo: unused, useSessions: unused, useSessionStatus: unused,
  useSessionRetainInfo: unused, useResource: unused, useWorkspaces: unused,
}

it('shows configured research workers and saves the selected worker', async () => {
  const form = stubConfigForm<ResearchSettings>()
  form.publish({ status: 'ready', writable: true, value: {
    model: 'qwen4b', workerLabel: 'Local 4B', workers: [{ id: 'flash', label: 'Flash', model: 'flash' }],
  }, revision: 2 })
  const face = new ResearchCardController(form.scope).inject()
  render(<ResearchCard {...{
    ...standard, ...face, t: makeTranslate(en, commonEn),
    useResearchCard: bindSnapshotSelector(face.hooks.researchCard),
  }} />)
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['Local 4B', 'Flash'])
  await act(async () => {
    fireEvent.change(screen.getByRole('combobox', { name: 'Research model' }), { target: { value: 'flash' } })
  })
  expect(form.set).toHaveBeenCalledWith('selectedWorker', 'flash')
})
