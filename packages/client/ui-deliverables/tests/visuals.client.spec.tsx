// @vitest-environment jsdom
/** Visual delivery parsing, original downloads, and isolated inline rendering. */
import { TextDecoder } from 'node:util'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ConversationNodeContext, ConversationStartMatch } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { Visuals } from '../src/client/Visuals.tsx'
import { mockupDocument, visualFile, visualsDefinition } from '../src/client/visuals.ts'
import { en } from '../src/client/locales.ts'

type Props = Parameters<typeof Visuals>[0]
const t = makeTranslate(en)
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function props(mediaType = 'image/svg+xml', source = '<svg/>'): Props {
  const file = visualFile({ path: 'chart.svg', description: 'Latency fell by half.', visual: {
    title: 'Latency chart', mediaType, data: Buffer.from(source).toString('base64'),
  } })
  if (file === null) throw new Error('Invalid fixture')
  return { node: { data: { files: [file] } }, t } as unknown as Props
}

it('shows a chart alongside its findings and offers the original bytes', () => {
  render(<Visuals {...props()} />)
  expect(screen.getByText('Latency fell by half.')).toBeTruthy()
  expect(screen.getByRole('img', { name: 'Latency chart' }).getAttribute('src')).toBe('data:image/svg+xml;base64,PHN2Zy8+')
  expect(screen.getByRole('link', { name: 'Download original' }).getAttribute('download')).toBe('chart.svg')
  fireEvent.click(screen.getByRole('button', { name: 'Expand view' }))
  expect(screen.getByRole('dialog', { name: 'Latency chart' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Close visual preview' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('isolates executable mockups from the parent and blocks external subresources', () => {
  vi.stubGlobal('TextDecoder', TextDecoder)
  render(<Visuals {...props('text/html', '<button onclick="this.textContent=2">1</button>')} />)
  const frame = screen.getByTitle('Latency chart')
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
  expect(frame.getAttribute('srcdoc')).toContain("connect-src 'none'")
  expect(frame.getAttribute('srcdoc')).toContain('onclick=')
  expect(frame.getAttribute('srcdoc')).toContain("frame-src 'none'")
})

it('reports undecodable images without hiding the caption or download', () => {
  render(<Visuals {...props('image/gif', 'invalid')} />)
  fireEvent.error(screen.getByRole('img'))
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(screen.getByText('Latency fell by half.')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Download original' })).toBeTruthy()
})

it.each([null, {}, { path: 'x', visual: { title: 'x', mediaType: 'text/javascript', data: 'YQ==' } },
  { path: 'x', visual: { title: 'x', mediaType: 'image/png', data: 'not base64' } }])(
  'declines malformed persisted visuals', (input) => { expect(visualFile(input)).toBeNull() },
)

it('rejects malformed UTF-8 and base64 before constructing srcdoc', () => {
  vi.stubGlobal('TextDecoder', TextDecoder)
  expect(mockupDocument('/w==')).toBeNull()
  expect(mockupDocument('!')).toBeNull()
})

it('keeps captions and downloads for a saved HTML snapshot with invalid encoding', () => {
  vi.stubGlobal('TextDecoder', TextDecoder)
  const input = props('text/html')
  const file = input.node.data.files[0]!
  render(<Visuals {...input} node={{ ...input.node, data: { files: [{ ...file, visual: { ...file.visual, data: '/w==' } }] } }} />)
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Download original' })).toBeTruthy()
})

it('keeps immutable delivery nodes outside process folding with their recorded order and location', () => {
  type State = ReturnType<typeof visualsDefinition.start>
  const empty: ConversationNodeContext<State> = {
    key: 'presented-visual:7', id: '7', kind: 'presented-visual', matches: [],
    start: undefined, state: undefined, current: new Map(),
  }
  const valid = { path: 'chart.svg', visual: { title: 'Chart', mediaType: 'image/svg+xml', data: 'PHN2Zy8+' } }
  const event = { seq: 7, time: 7, type: 'deliverables/presented', data: {
    turn: 1, callId: 'visual', files: [{ path: 'report.txt' }, valid],
  } } as SessionEvent<'deliverables/presented'>
  expect(visualsDefinition.match(event)).toEqual({ id: '7', role: 'start' })
  expect(visualsDefinition.match({ ...event, type: 'turn/start', data: { turn: 1 } })).toBeNull()
  expect(visualsDefinition.match({ ...event, data: {} } as unknown as SessionEvent)).toBeNull()
  expect(visualsDefinition.match({ ...event, data: { ...event.data, files: [{ path: 'report.txt' }] } })).toBeNull()
  expect(visualsDefinition.buildViewNode?.(empty)).toBeNull()
  const match: ConversationStartMatch = { event, role: 'start', location: { kind: 'session' } }
  const state = visualsDefinition.start(empty, match, { previous: () => undefined })
  const context = { ...empty, start: match, state }
  expect(visualsDefinition.update(context, match)).toBe(state)
  expect(visualsDefinition.buildViewNode?.(context)).toEqual({
    key: empty.key, id: '7', kind: 'presented-visual', target: 'chat', anchorSeq: 7,
    location: match.location, visibility: 'visible', processDisclosure: 'independent', data: { files: [valid] },
  })
})
