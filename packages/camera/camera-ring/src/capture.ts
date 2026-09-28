/**
 * Bounded frame capture for one event: scheduled snapshots at the event time and fixed intervals
 * after it, with one short live-stream capture for the remaining slots when snapshots fail.
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
  /** Whether a failed snapshot switches the remaining frames to a live stream. */
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

/** Stores one encoded JPEG frame and returns its durable reference. */
export type StoreFrame = (data: Uint8Array, index: number) => Promise<ImageAttachmentRef>

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
 * Capture up to `spec.frameCount` frames for one event received at `t0`. Consecutive snapshots with
 * identical bytes count once, so an unrefreshed snapshot yields fewer frames without a failure code.
 * @param camera - device to capture from.
 * @param spec - frame count, spacing, and timeouts.
 * @param t0 - event receipt time in epoch milliseconds.
 * @param store - commits one frame to the attachment store.
 * @param signal - provider shutdown.
 * @param deps - clock and delay seams.
 * @returns stored frames in capture order and any shortfall reason.
 */
export async function captureFrames(
  camera: RingCameraHandle, spec: CaptureSpec, t0: number, store: StoreFrame, signal: AbortSignal, deps: CaptureDeps,
): Promise<CaptureResult> {
  const frames: CameraFrame[] = []
  let previous: string | undefined
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
    if (data === TIMED_OUT) break
    const digest = createHash('sha256').update(data).digest('hex')
    if (digest === previous) continue
    previous = digest
    const capturedAt = deps.now()
    try {
      frames.push({ attachment: await store(data, frames.length), offsetMs: Math.max(0, capturedAt - t0), source: 'snapshot' })
    } catch {
      // The attachment error carries a stable code for its caller; the event reports the shortfall instead.
      return { frames, failure: 'storage-failed' }
    }
  }
  if (slot === spec.frameCount) return { frames }
  if (!spec.streamFallback) return { frames, failure: 'snapshot-unavailable' }
  return await captureStream(camera, spec, t0, spec.frameCount - slot, frames, store, signal, deps)
}

/** Capture the remaining frames from one live stream through ffmpeg into a private scratch directory. */
async function captureStream(
  camera: RingCameraHandle, spec: CaptureSpec, t0: number, count: number, frames: CameraFrame[],
  store: StoreFrame, signal: AbortSignal, deps: CaptureDeps,
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
      try {
        frames.push({
          attachment: await store(data, frames.length),
          offsetMs: Math.max(0, startedAt - t0) + index * spec.frameIntervalMs,
          source: 'stream',
        })
      } catch {
        // See the snapshot path: the event reports the shortfall.
        return { frames, failure: 'storage-failed' }
      }
      captured++
    }
    return captured === count ? { frames } : { frames, failure: 'stream-failed' }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
