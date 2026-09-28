/**
 * Bounded frame capture for one event: scheduled snapshots at the event time and fixed intervals
 * after it, with one short live-stream capture for the remaining slots when a snapshot fails or
 * repeats the previous one.
 * @module @deepseek-ai/dsh-camera-ring/capture
 */

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { CameraCaptureFailure, CameraFrame } from '@deepseek-ai/dsh-camera'
import type { RingCameraHandle, RingStreamHandle } from './client.ts'

/** Resolved capture bounds. */
export interface CaptureSpec {
  /** Frames to capture per event. */
  readonly frameCount: number
  /** Planned gap between frames, in milliseconds. */
  readonly frameIntervalMs: number
  /** Longest wait for one snapshot. */
  readonly snapshotTimeoutMs: number
  /** Whether a failed or repeated snapshot switches the remaining frames to a live stream. */
  readonly streamFallback: boolean
  /** Longest wait for a live stream to start transcoding. */
  readonly streamSetupMs: number
}

/** Clock and delay seams. */
export interface CaptureDeps {
  /** Current epoch milliseconds. */
  now(): number
  /** Resolve after `ms`, or reject when `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>
}

/** Frames captured for one event and the reason for any shortfall. */
export interface CaptureResult {
  readonly frames: readonly CameraFrame[]
  readonly failure?: CameraCaptureFailure
}

/** Where one event's captured frames go. */
export interface FrameSink {
  /**
   * Commit one encoded JPEG frame to the attachment store.
   * @param data - JPEG bytes.
   * @param index - zero-based position of the frame in the event.
   * @returns the frame's durable reference.
   */
  store(data: Uint8Array, index: number): Promise<ImageAttachmentRef>
  /**
   * Receive the event's first stored frame once, before capture continues.
   * @param frame - first frame with its offset and source.
   */
  first(frame: CameraFrame): Promise<void>
}

/** Marker for a bounded wait that expired. */
const TIMED_OUT = Symbol('timed out')

/** Race one operation against a delay; the delay also ends on cancellation. */
async function within<T>(operation: Promise<T>, ms: number, signal: AbortSignal, deps: CaptureDeps): Promise<T | typeof TIMED_OUT> {
  const bound = new AbortController()
  try {
    return await Promise.race([
      operation,
      deps.sleep(ms, AbortSignal.any([signal, bound.signal])).then((): typeof TIMED_OUT => TIMED_OUT, (): typeof TIMED_OUT => TIMED_OUT),
    ])
  } finally {
    bound.abort(new Error('capture wait settled'))
  }
}

/**
 * Capture up to `spec.frameCount` frames for one event received at `t0`. A snapshot whose bytes
 * repeat the previous snapshot counts as a missing live frame, like a refused or timed-out one: the
 * remaining slots, that one included, move to one live stream when `spec.streamFallback` is on, and
 * otherwise the result reports `snapshot-stale` or `snapshot-unavailable`.
 * @param camera - device to capture from.
 * @param spec - frame count, spacing, and timeouts.
 * @param t0 - event receipt time in epoch milliseconds.
 * @param sink - commits each frame and receives the first one.
 * @param signal - provider shutdown.
 * @param deps - clock and delay seams.
 * @returns stored frames in capture order and any shortfall reason.
 */
export async function captureFrames(
  camera: RingCameraHandle, spec: CaptureSpec, t0: number, sink: FrameSink, signal: AbortSignal, deps: CaptureDeps,
): Promise<CaptureResult> {
  const frames: CameraFrame[] = []
  const commit = async (data: Uint8Array, offsetMs: number, source: CameraFrame['source']): Promise<boolean> => {
    let attachment: ImageAttachmentRef
    try {
      attachment = await sink.store(data, frames.length)
    } catch {
      // The attachment error carries a stable code for its caller; the event reports the shortfall instead.
      return false
    }
    const frame: CameraFrame = { attachment, offsetMs, source }
    frames.push(frame)
    if (frames.length === 1) await sink.first(frame)
    return true
  }
  let previous: string | undefined
  let missing: 'snapshot-unavailable' | 'snapshot-stale' | undefined
  let slot = 0
  for (; slot < spec.frameCount; slot++) {
    const wait = t0 + slot * spec.frameIntervalMs - deps.now()
    if (wait > 0) await deps.sleep(wait, signal)
    signal.throwIfAborted()
    let data: Uint8Array | typeof TIMED_OUT
    try {
      data = await within(camera.snapshot(), spec.snapshotTimeoutMs, signal, deps)
    } catch {
      // The vendor error names the device and mode setting only; the fallback below reports the outcome.
      data = TIMED_OUT
    }
    signal.throwIfAborted()
    if (data === TIMED_OUT) {
      missing = 'snapshot-unavailable'
      break
    }
    const digest = createHash('sha256').update(data).digest('hex')
    if (digest === previous) {
      missing = 'snapshot-stale'
      break
    }
    previous = digest
    if (!await commit(data, Math.max(0, deps.now() - t0), 'snapshot')) return { frames, failure: 'storage-failed' }
  }
  if (missing === undefined) return { frames }
  if (!spec.streamFallback) return { frames, failure: missing }
  return await captureStream(camera, spec, t0, spec.frameCount - slot, frames, commit, signal, deps)
}

/** Commits one frame; false means the attachment store refused it. */
type Commit = (data: Uint8Array, offsetMs: number, source: CameraFrame['source']) => Promise<boolean>

/** Capture the remaining frames from one live stream through ffmpeg into a private scratch directory. */
async function captureStream(
  camera: RingCameraHandle, spec: CaptureSpec, t0: number, count: number, frames: readonly CameraFrame[],
  commit: Commit, signal: AbortSignal, deps: CaptureDeps,
): Promise<CaptureResult> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-camera-ring-'))
  try {
    const starting = camera.stream({
      audio: ['-an'],
      video: ['-vf', `fps=1000/${String(spec.frameIntervalMs)}`, '-q:v', '3'],
      output: ['-frames:v', String(count), '-f', 'image2', join(directory, 'frame-%02d.jpg')],
    })
    let stream: RingStreamHandle | typeof TIMED_OUT
    try {
      stream = await within(starting, spec.streamSetupMs, signal, deps)
    } catch {
      // A refused live call (mode settings, offline device) leaves no stream to stop.
      return { frames, failure: 'stream-failed' }
    }
    if (stream === TIMED_OUT) {
      void starting.then((late) => { late.stop() }, () => {
        // The late start failed, so there is no call left to end.
      })
      signal.throwIfAborted()
      return { frames, failure: 'stream-failed' }
    }
    const startedAt = deps.now()
    try {
      await within(stream.ended, count * spec.frameIntervalMs + spec.streamSetupMs, signal, deps)
    } finally {
      stream.stop()
    }
    signal.throwIfAborted()
    let captured = 0
    for (let index = 0; index < count; index++) {
      let data: Uint8Array
      try {
        data = await readFile(join(directory, `frame-${String(index + 1).padStart(2, '0')}.jpg`))
      } catch {
        // ffmpeg writes frames in order; the first missing file ends the sequence.
        break
      }
      if (!await commit(data, Math.max(0, startedAt - t0) + index * spec.frameIntervalMs, 'stream')) {
        return { frames, failure: 'storage-failed' }
      }
      captured++
    }
    return captured === count ? { frames } : { frames, failure: 'stream-failed' }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
