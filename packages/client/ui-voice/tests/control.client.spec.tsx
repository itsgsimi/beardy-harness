// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { GlobalStandardProps, SessionStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { VoiceControl } from '../src/client/VoiceControl.tsx'
import { en } from '../src/client/locales.ts'
import { recordAudio, transcribeAudio } from '../src/client/recording.ts'

vi.mock('../src/client/recording.ts', () => ({ recordAudio: vi.fn(), transcribeAudio: vi.fn() }))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.resetAllMocks() })
const unused = (): never => { throw new Error('VoiceControl does not use this slot fixture') }
const standard: GlobalStandardProps & SessionStandardProps = {
  sessionId: SessionId('voice'), useSession: unused, useProjection: unused,
  useConversation: unused, useInput: unused, useChat: unused, useTrajectory: unused,
  usePanelInfo: unused, useSessions: unused, useSessionStatus: unused,
  useSessionRetainInfo: unused, useResource: unused, useWorkspaces: unused,
  inputActions: { captureInsertion: unused, insertText: unused, setDraft: unused,
    addAttachments: unused, removeAttachment: unused, pruneAttachments: unused, submit: unused },
}
function setup(append = vi.fn(() => true)) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ maxAudioBytes: 1000, maxDurationSeconds: 180 }) })))
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } })
  vi.stubGlobal('MediaRecorder', vi.fn())
  const input: InputState = { draft: '', attachmentIds: [], draftRev: 0, phase: 'plain', occurrences: [], queue: [] }
  const props = { ...standard, append, useInput: <S,>(select: (state: InputState) => S): S => select(input),
    t: makeTranslate(en, commonEn) } satisfies ComponentProps<typeof VoiceControl>
  return { append, ...render(<VoiceControl {...props} />) }
}
describe('composer voice control', () => {
  it('records, transcribes and appends without submitting the message', async () => {
    const { append } = setup()
    vi.mocked(recordAudio).mockImplementation(async (_signal, _limits, ready) => {
      return new Promise((resolve) => { ready(() => { resolve(new Blob(['audio'])) }) })
    })
    vi.mocked(transcribeAudio).mockResolvedValue('Inspect the last change.')
    fireEvent.click(await screen.findByRole('button', { name: en.start }))
    fireEvent.click(await screen.findByRole('button', { name: en.stop }))
    await waitFor(() => { expect(append).toHaveBeenCalledWith('Inspect the last change.') })
    expect(screen.getByRole('button', { name: en.start })).toBeTruthy()
  })
  it('cancels on session unmount and discards a late transcript', async () => {
    const { append, unmount } = setup()
    vi.mocked(recordAudio).mockResolvedValue(new Blob(['audio']))
    let finish!: (text: string) => void
    vi.mocked(transcribeAudio).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    fireEvent.click(await screen.findByRole('button', { name: en.start }))
    await screen.findByText(en.transcribing)
    const signal = vi.mocked(transcribeAudio).mock.calls[0]![1]
    unmount(); expect(signal.aborted).toBe(true)
    finish('late result')
    await Promise.resolve(); expect(append).not.toHaveBeenCalled()
  })
  it('explains the secure-context requirement and handles silence', async () => {
    setup(); vi.stubGlobal('isSecureContext', false)
    fireEvent.click(await screen.findByRole('button', { name: en.start }))
    await screen.findByText(en.unsupported)
    vi.stubGlobal('isSecureContext', true)
    vi.mocked(recordAudio).mockResolvedValue(new Blob(['audio']))
    vi.mocked(transcribeAudio).mockResolvedValue('')
    fireEvent.click(screen.getByRole('button', { name: en.start }))
    await screen.findByText(en.empty)
  })
  it('retains text for insertion if the composer is temporarily locked', async () => {
    const { append } = setup(vi.fn().mockReturnValueOnce(false).mockReturnValue(true))
    vi.mocked(recordAudio).mockResolvedValue(new Blob(['audio']))
    vi.mocked(transcribeAudio).mockResolvedValue('Keep this transcript.')
    fireEvent.click(await screen.findByRole('button', { name: en.start }))
    fireEvent.click(await screen.findByRole('button', { name: en.insert }))
    expect(append).toHaveBeenLastCalledWith('Keep this transcript.')
  })
})
