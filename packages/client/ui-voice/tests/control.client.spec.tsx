// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    addAttachments: unused, removeAttachment: unused, pruneAttachments: unused, submit: unused, persistDraft: unused },
}
interface SetupOptions {
  /** Answers the speech config request. */
  config?: () => Promise<unknown>
  reactStrictMode?: boolean
}
function setup(append = vi.fn(() => true), {
  config = async () => ({ ok: true, json: async () => ({ maxAudioBytes: 1000, maxDurationSeconds: 180 }) }),
  reactStrictMode = false,
}: SetupOptions = {}) {
  vi.stubGlobal('fetch', vi.fn(config))
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } })
  vi.stubGlobal('MediaRecorder', vi.fn())
  const input: InputState = { draft: '', attachmentIds: [], draftRev: 0, phase: 'plain', occurrences: [], queue: [] }
  const props = { ...standard, append, useInput: <S,>(select: (state: InputState) => S): S => select(input),
    t: makeTranslate(en, commonEn) } satisfies ComponentProps<typeof VoiceControl>
  return { append, ...render(<VoiceControl {...props} />, { reactStrictMode }) }
}
describe('composer voice control', () => {
  it('records, transcribes and appends without submitting the message', async () => {
    const { append } = setup()
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('api/speech/config')
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
  it('retains text for insertion until the temporarily locked composer accepts it', async () => {
    const { append } = setup(vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true))
    vi.mocked(recordAudio).mockResolvedValue(new Blob(['audio']))
    vi.mocked(transcribeAudio).mockResolvedValue('Keep this transcript.')
    fireEvent.click(await screen.findByRole('button', { name: en.start }))
    fireEvent.click(await screen.findByRole('button', { name: en.insert }))
    expect(append).toHaveBeenLastCalledWith('Keep this transcript.')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.start }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.insert }))
    expect(append).toHaveBeenCalledTimes(3)
    expect(screen.queryByRole('button', { name: en.insert })).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.start }).disabled).toBe(false)
  })
  it('reports a failed transcription and offers the microphone again', async () => {
    const { append } = setup()
    vi.mocked(recordAudio).mockResolvedValue(new Blob(['audio']))
    vi.mocked(transcribeAudio).mockRejectedValue(new Error('transcription-failed'))
    fireEvent.click(await screen.findByRole('button', { name: en.start }))
    await screen.findByText(en.failed)
    expect(screen.getByRole('button', { name: en.start })).toBeTruthy()
    expect(append).not.toHaveBeenCalled()
  })
  it('cancels a recording back to the idle microphone without reporting a failure', async () => {
    setup()
    const capture = Promise.withResolvers<Blob>()
    vi.mocked(recordAudio).mockImplementation((signal, _limits, ready) => {
      signal.addEventListener('abort', () => { capture.reject(new Error('recording-aborted')) })
      ready(() => undefined)
      return capture.promise
    })
    fireEvent.click(await screen.findByRole('button', { name: en.start }))
    expect(screen.getByRole('button', { name: en.stop })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(vi.mocked(recordAudio).mock.calls[0]![0].aborted).toBe(true)
    // The control awaited this capture first, so its catch and finally have run once this await resumes.
    await act(async () => { await capture.promise.catch(() => undefined) })
    expect(screen.getByRole('button', { name: en.start })).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
    expect(transcribeAudio).not.toHaveBeenCalled()
  })
  it('contributes no microphone when the speech provider answers unsuccessfully', async () => {
    const response = { ok: false, json: vi.fn() }
    const config = Promise.resolve(response)
    const { container } = setup(undefined, { config: () => config })
    expect(fetch).toHaveBeenCalledOnce()
    // The control's response handler was registered first, so it has returned once this await resumes.
    await act(async () => { await config })
    expect(response.json).not.toHaveBeenCalled()
    expect(container.childElementCount).toBe(0)
  })
  it('contributes no microphone when the speech config request cannot reach the server', async () => {
    const config = Promise.reject(new TypeError('Failed to fetch'))
    const { container } = setup(undefined, { config: () => config })
    // The control's rejection handler was queued before this catch settles, so it has run once the await resumes.
    await act(async () => { await config.catch(() => undefined) })
    expect(container.childElementCount).toBe(0)
  })
  it('contributes no microphone when the speech limits are not positive numbers', async () => {
    const body = Promise.resolve({ maxAudioBytes: 0, maxDurationSeconds: 180 })
    const config = Promise.resolve({ ok: true, json: () => body })
    const { container } = setup(undefined, { config: () => config })
    // Each await resumes after the control's own continuation on the same promise.
    await act(async () => { await config; await body })
    expect(container.childElementCount).toBe(0)
  })
  it('keeps the mounted request limits when an abandoned config request answers late', async () => {
    const requests: PromiseWithResolvers<unknown>[] = []
    setup(undefined, { reactStrictMode: true, config: () => {
      const request = Promise.withResolvers<unknown>()
      requests.push(request)
      return request.promise
    } })
    // Strict mode mounts the control, abandons that mount, and mounts it again.
    expect(vi.mocked(fetch).mock.calls.map(([, init]) => init?.signal?.aborted)).toEqual([true, false])
    const abandoned = requests[0]!
    const mounted = requests[1]!
    const current = Promise.resolve({ maxAudioBytes: 2000, maxDurationSeconds: 60 })
    const stale = Promise.resolve({ maxAudioBytes: 1, maxDurationSeconds: 1 })
    await act(async () => { mounted.resolve({ ok: true, json: () => current }); await mounted.promise; await current })
    await act(async () => { abandoned.resolve({ ok: true, json: () => stale }); await abandoned.promise; await stale })
    vi.mocked(recordAudio).mockReturnValue(new Promise<Blob>(() => undefined))
    fireEvent.click(screen.getByRole('button', { name: en.start }))
    expect(recordAudio).toHaveBeenCalledWith(
      expect.any(AbortSignal), { maxAudioBytes: 2000, maxDurationSeconds: 60 }, expect.any(Function))
    expect(screen.getByRole('status').textContent).toBe(en.requesting)
  })
})
