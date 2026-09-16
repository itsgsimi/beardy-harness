/** Browser-owned microphone lifetime; no audio leaves the browser before Stop. */
export interface RecordingLimits {
  readonly maxAudioBytes: number
  readonly maxDurationSeconds: number
}

/**
 * Capture one recording and release every track on stop, failure, or cancellation.
 * @param signal - caller cancellation; aborting discards the capture.
 * @param limits - encoded-byte and duration ceilings enforced during capture.
 * @param ready - receives the stop function once the recorder is running.
 * @returns the captured clip in the first container the browser supports.
 */
export async function recordAudio(
  signal: AbortSignal, limits: RecordingLimits, ready: (stop: () => void) => void,
): Promise<Blob> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  try {
    signal.throwIfAborted()
    const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']
      .find(type => MediaRecorder.isTypeSupported(type))
    const recorder = new MediaRecorder(stream, mimeType === undefined ? {} : { mimeType })
    return await new Promise<Blob>((resolve, reject) => {
      const chunks: Blob[] = []
      let size = 0
      let failure: Error | undefined
      const stop = (): void => { if (recorder.state !== 'inactive') recorder.stop() }
      const abort = (): void => {
        failure = signal.reason instanceof Error ? signal.reason : new Error('recording-aborted')
        stop()
      }
      const timer = setTimeout(stop, limits.maxDurationSeconds * 1000)
      signal.addEventListener('abort', abort, { once: true })
      recorder.ondataavailable = ({ data }) => {
        size += data.size
        if (size > limits.maxAudioBytes) {
          failure = new Error('recording-too-large')
          stop()
        } else chunks.push(data)
      }
      recorder.onerror = () => { failure = new Error('recording-failed'); stop() }
      recorder.onstop = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        if (failure !== undefined) reject(failure)
        else resolve(new Blob(chunks, { type: recorder.mimeType }))
      }
      try {
        recorder.start(250)
        ready(stop)
      } catch (error) {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        reject(error instanceof Error ? error : new Error('recording-failed'))
      }
    })
  } finally {
    for (const track of stream.getTracks()) track.stop()
  }
}

/**
 * Upload a completed clip to the authenticated connection's binary route.
 * @param audio - the captured clip; its media type becomes the request content type.
 * @param signal - caller cancellation for the upload and the wait for text.
 * @returns the recognized text, empty when the backend detected no speech.
 */
export async function transcribeAudio(audio: Blob, signal: AbortSignal): Promise<string> {
  const response = await fetch('/api/speech', {
    method: 'POST', body: audio, signal,
    headers: { 'content-type': audio.type || 'application/octet-stream' },
  })
  if (!response.ok) throw new Error('transcription-failed')
  const result: unknown = await response.json()
  if (typeof result !== 'object' || result === null || !('text' in result) || typeof result.text !== 'string') {
    throw new Error('transcription-failed')
  }
  return result.text.trim()
}
