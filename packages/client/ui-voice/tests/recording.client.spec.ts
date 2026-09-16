import { afterEach, describe, expect, it, vi } from 'vitest'
import { recordAudio, transcribeAudio } from '../src/client/recording.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
class Recorder {
  static isTypeSupported = () => true
  static current: Recorder
  state = 'inactive'; mimeType = 'audio/webm'; ondataavailable?: (e: { data: Blob }) => void
  onstop?: () => void; onerror?: () => void
  constructor() { Recorder.current = this }
  start() { this.state = 'recording' }
  stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['audio']) }); this.onstop?.() }
}
function setup() {
  const stopTrack = vi.fn()
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) } })
  vi.stubGlobal('MediaRecorder', Recorder)
  return stopTrack
}
const limits = { maxAudioBytes: 100, maxDurationSeconds: 180 }
describe('microphone lifetime', () => {
  it('returns a stopped clip and closes the microphone', async () => {
    const stopped = setup()
    const audio = await recordAudio(new AbortController().signal, limits, stop => stop())
    expect(await audio.text()).toBe('audio'); expect(stopped).toHaveBeenCalledOnce()
  })
  it('discards cancelled recording and closes the microphone', async () => {
    const stopped = setup(); const controller = new AbortController()
    await expect(recordAudio(controller.signal, limits, () => controller.abort())).rejects.toThrow()
    expect(stopped).toHaveBeenCalledOnce()
  })
  it('releases microphone permission granted after cancellation', async () => {
    const stopped = setup(); const controller = new AbortController(); controller.abort()
    await expect(recordAudio(controller.signal, limits, vi.fn())).rejects.toThrow()
    expect(stopped).toHaveBeenCalledOnce()
  })
  it('rejects oversized recordings and stops at the duration limit', async () => {
    const stopped = setup()
    await expect(recordAudio(new AbortController().signal, { ...limits, maxAudioBytes: 1 }, stop => stop())).rejects.toThrow('large')
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
})
