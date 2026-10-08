// @vitest-environment jsdom
/** Research call rows: running and settled states, report viewing, download cleanup, and unsafe sources. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import type { GlobalStandardProps, SessionStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { ResearchRow } from '../src/client/ResearchRow.tsx'
import { en } from '../src/client/locales.ts'

type Props = Parameters<typeof ResearchRow>[0]
const t = makeTranslate(en, commonEn) as Props['t']
const unused = (): never => { throw new Error('ResearchRow does not use this slot fixture') }
const standard: GlobalStandardProps & SessionStandardProps = {
  sessionId: SessionId('research-row'), useSession: unused, useProjection: unused,
  useConversation: unused, useInput: unused, useChat: unused, useTrajectory: unused,
  usePanelInfo: unused, useSessions: unused, useSessionStatus: unused,
  useSessionRetainInfo: unused, useResource: unused, useWorkspaces: unused,
  inputActions: { captureInsertion: unused, insertText: unused, setDraft: unused,
    addAttachments: unused, removeAttachment: unused, pruneAttachments: unused, submit: unused, persistDraft: unused },
}
const common = {
  ...standard, callId: 'research', openFile: unused, loadImage: unused, t,
  useDisclosure: () => ({ expanded: false, setExpanded: vi.fn(), toggle: vi.fn() }),
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function settled(meta: unknown, overrides: Partial<ToolResultNode> = {}, name = 'odysseus_research'): Props {
  const argsRaw = '{"action":"report","id":"rp-report"}'
  const block: ToolResultNode = {
    kind: 'tool-result', seq: 10, time: 2000, callTime: 1000, callId: 'research',
    name, args: PartialArguments.fromText(argsRaw), call: { name, argsRaw },
    content: [{ type: 'text', text: 'A short model page' }], isError: false, subCalls: [], meta, ...overrides,
  }
  return { ...common, phase: 'result', toolName: name, block }
}

function started(argsRaw: string): Props {
  return { ...common, phase: 'start', toolName: 'deep_research',
    block: { callId: 'research', name: 'deep_research', phase: 'start', argsRaw, args: PartialArguments.fromText(argsRaw) } as never }
}

it.each(['odysseus_research', 'deep_research'])('opens a %s report and releases its download URL on close', (name) => {
  const create = vi.fn((_blob: Blob) => 'blob:research-report')
  const revoke = vi.fn()
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }))
  render(<ResearchRow {...settled({ researchArtifact: {
    id: 'rp-report', markdown: '# Full report\n\nEvidence beyond the short model page.\n\n<script>bad()</script>',
    sources: [{ url: 'https://docs.python.org/', title: 'Python docs' }, { url: 'javascript:bad()', title: 'Unsafe source' }, { url: 'not a url' }],
  } }, {}, name)} />)
  expect(screen.getAllByText('rp-report').length).toBeGreaterThan(0)
  expect(screen.queryByText('Evidence beyond the short model page.')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en['report.open'] }))
  expect(screen.getByRole('dialog', { name: en['report.title'] })).toBeTruthy()
  expect(screen.getByText('Evidence beyond the short model page.')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Python docs' }).getAttribute('href')).toBe('https://docs.python.org/')
  expect(screen.getByText('Unsafe source').getAttribute('href')).toBeNull()
  expect(screen.getByText('not a url').getAttribute('href')).toBeNull()
  expect(screen.getByRole('dialog').querySelector('script')).toBeNull()
  expect(screen.getByRole('link', { name: en['report.download'] }).getAttribute('download')).toBe('rp-report.md')
  fireEvent.click(screen.getByRole('button', { name: en['report.close'] }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(revoke).toHaveBeenCalledWith('blob:research-report')
})

it('downloads the report followed by its numbered sources', async () => {
  const create = vi.fn((_blob: Blob) => 'blob:research-report')
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: vi.fn() }))
  render(<ResearchRow {...settled({ researchArtifact: {
    id: 'rp-report', markdown: '# Report', sources: [{ url: 'https://a.example/', title: 'A' }, { url: 'https://b.example/' }],
  } })} />)
  fireEvent.click(screen.getByRole('button', { name: en['report.open'] }))
  expect(await create.mock.calls[0]![0].text()).toBe('# Report\n\nSources\n\n1. A\n   https://a.example/\n2. https://b.example/\n   https://b.example/\n')
})

it.each([undefined, {}, { researchArtifact: null }, { researchArtifact: { id: 'rp-report', markdown: 'bad', sources: [null] } },
  { researchArtifact: { id: 'rp-report', markdown: 'bad', sources: [{ url: 'https://a.example/', title: 3 }] } }])(
  'keeps malformed or missing report metadata on the expandable call row', (meta) => {
    const inspect = vi.fn()
    render(<ResearchRow {...settled(meta)} inspect={inspect} />)
    expect(screen.queryByRole('button', { name: en['report.open'] })).toBeNull()
    expect(screen.getAllByText(en['row.ok']).length).toBeGreaterThan(0)
    fireEvent.click(screen.getAllByText('rp-report')[0]!)
    expect(screen.getByText('A short model page')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['row.inspect'] }))
    expect(inspect).toHaveBeenCalledOnce()
  },
)

it('shows failed and stopped calls without a report even when metadata exists', () => {
  const meta = { researchArtifact: { id: 'rp-x', markdown: 'm', sources: [] } }
  const failed = render(<ResearchRow {...settled(meta, { isError: true, content: [{ type: 'image', data: 'x', mimeType: 'image/png' } as never] })} />)
  expect(failed.getAllByText(en['row.error']).length).toBeGreaterThan(0)
  expect(failed.queryByRole('button', { name: en['report.open'] })).toBeNull()
  failed.unmount()
  const stopped = render(<ResearchRow {...settled(undefined, { isError: true, call: null, error: { name: 'Aborted', code: 'interrupted' } })} />)
  expect(stopped.getAllByText(en['row.stopped']).length).toBeGreaterThan(0)
  expect(stopped.container.querySelector('[data-state="stopped"]')).toBeTruthy()
})

it.each([
  ['{"action":"start","query":"Compare heat pumps"}', 'Compare heat pumps'],
  ['{"action":"status","id":"rp-1"}', 'rp-1'],
  ['{"action":"list","query":"  "}', 'list'],
  ['{"action":', ''],
  ['null', ''],
  ['{"action":7}', ''],
])('summarizes running call arguments %s', (argsRaw, summary) => {
  const view = render(<ResearchRow {...started(argsRaw)} />)
  expect(view.getAllByText(en['row.running']).length).toBeGreaterThan(0)
  expect(view.container.querySelector('[data-tool="deep_research"]')?.getAttribute('data-state')).toBe('running')
  if (summary) expect(view.getAllByText(summary).length).toBeGreaterThan(0)
  expect(view.queryByRole('button', { name: en['report.open'] })).toBeNull()
})

it('renders a preparing call without disclosure', () => {
  const view = render(<ResearchRow {...common} phase="preparing" toolName="deep_research"
    block={{ callId: 'research', name: 'deep_research', phase: 'preparing' } as never} />)
  expect(view.container.querySelector('[data-state="preparing"]')).toBeTruthy()
  expect(view.getByText(en['row.title'])).toBeTruthy()
})
