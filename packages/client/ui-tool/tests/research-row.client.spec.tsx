// @vitest-environment jsdom
/** Durable report viewing, download cleanup, and unsafe source handling. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import type { GlobalStandardProps, SessionStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { en } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { ResearchRow } from '../src/client/tool/toolviews/research-row.tsx'

type Props = Parameters<typeof ResearchRow>[0]
const t: Props['t'] = makeTranslate(en, commonEn)
const unused = (): never => { throw new Error('ResearchRow does not use this slot fixture') }
const standard: GlobalStandardProps & SessionStandardProps = {
  sessionId: SessionId('research-row'), useSession: unused, useProjection: unused,
  useConversation: unused, useInput: unused, useChat: unused, useTrajectory: unused,
  usePanelInfo: unused, useSessions: unused, useSessionStatus: unused,
  useSessionRetainInfo: unused, useResource: unused, useWorkspaces: unused,
  inputActions: { captureInsertion: unused, insertText: unused, setDraft: unused,
    addAttachments: unused, removeAttachment: unused, pruneAttachments: unused, submit: unused, persistDraft: unused },
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function props(meta: unknown, isError = false, name = 'odysseus_research'): Props {
  const argsRaw = '{"action":"report","id":"rp-report"}'
  const block: ToolResultNode = {
    kind: 'tool-result', seq: 10, time: 2000, callTime: 1000, callId: 'research',
    name, args: PartialArguments.fromText(argsRaw),
    call: { name, argsRaw },
    content: [{ type: 'text', text: 'A short model page' }], isError, subCalls: [], meta,
  }
  return {
    ...standard, callId: 'research', openFile: unused, loadImage: unused,
    phase: 'result', toolName: name, block, t,
    useDisclosure: () => ({ expanded: false, setExpanded: vi.fn(), toggle: vi.fn() }),
  }
}

it.each(['odysseus_research', 'deep_research'])('opens a %s report and releases its download URL on close', (name) => {
  const create = vi.fn(() => 'blob:research-report')
  const revoke = vi.fn()
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }))
  render(<ResearchRow {...props({ researchArtifact: {
    id: 'rp-report', markdown: '# Full report\n\nEvidence beyond the short model page.\n\n<script>bad()</script>',
    sources: [{ url: 'https://docs.python.org/', title: 'Python docs' }, { url: 'javascript:bad()', title: 'Unsafe source' }],
  } }, false, name)} />)
  expect(screen.queryByText('Evidence beyond the short model page.')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Open research report' }))
  expect(screen.getByRole('dialog', { name: 'Research report' })).toBeTruthy()
  expect(screen.getByText('Evidence beyond the short model page.')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Python docs' }).getAttribute('href')).toBe('https://docs.python.org/')
  expect(screen.getByText('Unsafe source').getAttribute('href')).toBeNull()
  expect(screen.getByRole('dialog').querySelector('script')).toBeNull()
  expect(screen.getByRole('link', { name: 'Download Markdown' }).getAttribute('download')).toBe('rp-report.md')
  fireEvent.click(screen.getByRole('button', { name: 'Close report' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(revoke).toHaveBeenCalledWith('blob:research-report')
})

it.each([undefined, {}, { researchArtifact: { id: 'rp-report', markdown: 'bad', sources: [null] } }])(
  'keeps malformed or missing artifact metadata on the ordinary tool row', (meta) => {
    render(<ResearchRow {...props(meta)} />)
    expect(screen.queryByRole('button', { name: 'Open research report' })).toBeNull()
  },
)
