// @vitest-environment jsdom
/** Durable report viewing, download cleanup, and unsafe source handling. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { en } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { ResearchRow } from '../src/client/tool/toolviews/research-row.tsx'

type Props = Parameters<typeof ResearchRow>[0]
const t: Props['t'] = makeTranslate(en, commonEn)
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function props(meta: unknown, isError = false): Props {
  const block: ToolResultNode = {
    kind: 'tool-result', seq: 10, time: 2000, callTime: 1000, callId: 'research',
    call: { name: 'odysseus_research', argsRaw: '{"action":"report","id":"rp-report"}' },
    content: [{ type: 'text', text: 'A short model page' }], isError, subCalls: [], meta,
  }
  return { callId: 'research', toolName: 'odysseus_research', block, t, openFile: vi.fn(), sessionId: 's1' } as unknown as Props
}

it('opens the complete saved artifact and releases its download URL on close', () => {
  const create = vi.fn(() => 'blob:research-report')
  const revoke = vi.fn()
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }))
  render(<ResearchRow {...props({ researchArtifact: {
    id: 'rp-report', markdown: '# Full report\n\nEvidence beyond the short model page.\n\n<script>bad()</script>',
    sources: [{ url: 'https://docs.python.org/', title: 'Python docs' }, { url: 'javascript:bad()', title: 'Unsafe source' }],
  } })} />)
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
