import { afterEach, describe, expect, it, vi } from 'vitest'
import { recordAudio, transcribeAudio } from '../src/client/recording.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
class Recorder {
  static isTypeSupported = () => true
  static current: Recorder
  state = 'inactive'; mimeType = 'audio/webm'; ondataavailable?: (e: { data: Blob }) => void
  onstop?: () => void; onerror?: () => void
  constructor(_stream: unknown, readonly options: MediaRecorderOptions) { Recorder.current = this }
  start() { this.state = 'recording' }
  stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['audio']) }); this.onstop?.() }
}
function setup(recorder: typeof Recorder = Recorder) {
  const stopTrack = vi.fn()
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) } })
  vi.stubGlobal('MediaRecorder', recorder)
  return stopTrack
}
const limits = { maxAudioBytes: 100, maxDurationSeconds: 180 }
describe('microphone lifetime', () => {
  it('returns a stopped clip and closes the microphone', async () => {
    const stopped = setup()
    const audio = await recordAudio(new AbortController().signal, limits, (stop) => { stop() })
    expect(await audio.text()).toBe('audio'); expect(stopped).toHaveBeenCalledOnce()
    expect(Recorder.current.options).toEqual({ mimeType: 'audio/webm;codecs=opus' })
  })
  it('lets the browser choose the container when no preferred codec is supported', async () => {
    class DefaultContainer extends Recorder { static override isTypeSupported = () => false }
    setup(DefaultContainer)
    const audio = await recordAudio(new AbortController().signal, limits, (stop) => { stop() })
    expect(Recorder.current.options).toEqual({})
    expect(audio.type).toBe('audio/webm')
  })
  it('fails the capture when the recorder reports an error', async () => {
    const stopped = setup()
    await expect(recordAudio(new AbortController().signal, limits, () => { Recorder.current.onerror?.() }))
      .rejects.toThrow('recording-failed')
    expect(stopped).toHaveBeenCalledOnce()
  })
  it('releases the microphone and duration timer when the recorder cannot start', async () => {
    vi.useFakeTimers()
    class Unstartable extends Recorder { override start() { throw new Error('NotSupportedError') } }
    const stopped = setup(Unstartable)
    const ready = vi.fn()
    await expect(recordAudio(new AbortController().signal, limits, ready)).rejects.toThrow('NotSupportedError')
    expect(ready).not.toHaveBeenCalled(); expect(stopped).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    class ThrowsValue extends Recorder { override start() { throw 'unsupported' } }
    setup(ThrowsValue)
    await expect(recordAudio(new AbortController().signal, limits, ready)).rejects.toThrow('recording-failed')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('discards cancelled recording and closes the microphone', async () => {
    const stopped = setup(); const controller = new AbortController()
    await expect(recordAudio(controller.signal, limits, () => { controller.abort() })).rejects.toThrow()
    expect(stopped).toHaveBeenCalledOnce()
  })
  it('reports a generic abort when cancellation carries no error', async () => {
    const stopped = setup(); const controller = new AbortController()
    await expect(recordAudio(controller.signal, limits, () => { controller.abort('closed') })).rejects.toThrow('recording-aborted')
    expect(stopped).toHaveBeenCalledOnce()
  })
  it('releases microphone permission granted after cancellation', async () => {
    const stopped = setup(); const controller = new AbortController(); controller.abort()
    await expect(recordAudio(controller.signal, limits, vi.fn())).rejects.toThrow()
    expect(stopped).toHaveBeenCalledOnce()
  })
  it('rejects oversized recordings and stops at the duration limit', async () => {
    const stopped = setup()
    await expect(recordAudio(new AbortController().signal, { ...limits, maxAudioBytes: 1 }, (stop) => { stop() })).rejects.toThrow('large')
    expect(stopped).toHaveBeenCalledOnce()
    vi.useFakeTimers()
    const pending = recordAudio(new AbortController().signal, { ...limits, maxDurationSeconds: 1 }, vi.fn())
    await vi.advanceTimersByTimeAsync(1000)
    expect((await pending).size).toBe(5)
  })
  it('does not accept an unsuccessful transcription response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 422 })))
    await expect(transcribeAudio(new Blob(), new AbortController().signal)).rejects.toThrow('transcription-failed')
  })
  it('does not accept a response without recognized text', async () => {
    for (const body of [null, {}, { text: 42 }]) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)))
      await expect(transcribeAudio(new Blob(['clip']), new AbortController().signal)).rejects.toThrow('transcription-failed')
    }
  })
  it('posts a clip to the document-relative speech route', async () => {
    const fetch = vi.fn(async () => Response.json({ text: '  Hello.  ' }))
    vi.stubGlobal('fetch', fetch)
    expect(await transcribeAudio(new Blob(['clip']), new AbortController().signal)).toBe('Hello.')
    expect(fetch).toHaveBeenCalledWith('api/speech', expect.objectContaining({ method: 'POST' }))
  })
})
