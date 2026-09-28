import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { captureFrames } from '../src/capture.ts'
import type { CaptureSpec, FrameSink } from '../src/capture.ts'
import { FakeCamera, FakeClock } from './support.ts'

const spec: CaptureSpec = { frameCount: 3, frameIntervalMs: 10_000, snapshotTimeoutMs: 20_000, streamFallback: true, streamSetupMs: 20_000 }

const bytes = (value: number): Uint8Array => new Uint8Array([0xff, 0xd8, value])

function recorder(failAt?: number): { store: FrameSink; stored: number[][]; firsts: string[] } {
  const stored: number[][] = []
  const firsts: string[] = []
  return {
    stored,
    firsts,
    store: {
      store: async (data, index) => {
        if (index === failAt) throw new Error('storage full')
        stored.push([...data])
        return { attachmentId: AttachmentId(`sha256:${String(index)}`), mediaType: 'image/jpeg', bytes: data.length, width: 8, height: 6 } satisfies ImageAttachmentRef
      },
      first: async (frame) => { firsts.push(`${frame.attachment.attachmentId}@${String(frame.offsetMs)}:${frame.source}`) },
    },
  }
}

describe('captureFrames', () => {
  it('takes scheduled snapshots at the event time and each interval after it', async () => {
    const clock = new FakeClock()
    const camera = new FakeCamera(1, 'Front Door')
    camera.snapshots.push(bytes(1), bytes(2), bytes(3))
    const { store, stored, firsts } = recorder()
    const t0 = clock.time
    const result = await captureFrames(camera, spec, t0, store, new AbortController().signal, clock)
    expect(result.failure).toBeUndefined()
    expect(stored).toEqual([[0xff, 0xd8, 1], [0xff, 0xd8, 2], [0xff, 0xd8, 3]])
    expect(result.frames.map(frame => [frame.offsetMs, frame.source])).toEqual([[0, 'snapshot'], [10_000, 'snapshot'], [20_000, 'snapshot']])
    expect(clock.sleeps.filter(ms => ms !== spec.snapshotTimeoutMs)).toEqual([10_000, 10_000])
    expect(firsts).toEqual(['sha256:0@0:snapshot'])
  })

  it('moves the remaining slots to the live stream when a snapshot repeats the previous bytes', async () => {
    const clock = new FakeClock()
    const camera = new FakeCamera(1, 'Front Door')
    camera.snapshots.push(bytes(1), bytes(1), bytes(2))
    camera.stream_ = { frames: [bytes(7), bytes(8)] }
    const { store, stored, firsts } = recorder()
    const t0 = clock.time
    const result = await captureFrames(camera, spec, t0, store, new AbortController().signal, clock)
    expect(result.failure).toBeUndefined()
    expect(stored).toEqual([[0xff, 0xd8, 1], [0xff, 0xd8, 7], [0xff, 0xd8, 8]])
    expect(result.frames.map(frame => [frame.offsetMs, frame.source])).toEqual([[0, 'snapshot'], [10_000, 'stream'], [20_000, 'stream']])
    expect(camera.snapshotCalls).toBe(2)
    expect(camera.streams[0]?.output.slice(0, 2)).toEqual(['-frames:v', '2'])
    expect(result.snapshotMiss).toEqual({ reason: 'stale', slot: 1, remaining: 2 })
    expect(result.streamFailure).toBeUndefined()
    expect(firsts).toEqual(['sha256:0@0:snapshot'])
  })

  it('reports snapshot-stale when a snapshot repeats and the stream fallback is off', async () => {
    const clock = new FakeClock()
    const camera = new FakeCamera(1, 'Front Door')
    camera.snapshots.push(bytes(1), bytes(2), bytes(2))
    const { store, stored } = recorder()
    const result = await captureFrames(camera, { ...spec, streamFallback: false }, clock.time, store, new AbortController().signal, clock)
    expect(result).toMatchObject({ failure: 'snapshot-stale', frames: [{ offsetMs: 0 }, { offsetMs: 10_000 }], snapshotMiss: { reason: 'stale', slot: 2, remaining: 1 } })
    expect(stored).toHaveLength(2)
    expect(camera.streams).toEqual([])
  })

  it('reports stream-failed when a repeated snapshot leaves slots the stream cannot fill', async () => {
    const clock = new FakeClock()
    const camera = new FakeCamera(1, 'Front Door')
    camera.snapshots.push(bytes(1), bytes(1))
    camera.stream_ = { refuse: true }
    const result = await captureFrames(camera, spec, clock.time, recorder().store, new AbortController().signal, clock)
    expect(result).toMatchObject({ failure: 'stream-failed', frames: [{ source: 'snapshot' }] })
    expect(result.streamFailure).toEqual({ stage: 'start-refused', error: 'Live view is currently disabled' })
  })

  it('reports a storage refusal and keeps the frames already stored', async () => {
    const clock = new FakeClock()
    const camera = new FakeCamera(1, 'Front Door')
    camera.snapshots.push(bytes(1), bytes(2))
    const result = await captureFrames(camera, spec, clock.time, recorder(1).store, new AbortController().signal, clock)
    expect(result.failure).toBe('storage-failed')
    expect(result.frames).toHaveLength(1)
  })

  it('reports snapshot-unavailable when a snapshot fails and the stream fallback is off', async () => {
    const clock = new FakeClock()
    const camera = new FakeCamera(1, 'Front Door')
    camera.snapshots.push(bytes(1), new Error('Motion detection is disabled for Front Door'))
    const noFallback = { ...spec, streamFallback: false }
    const result = await captureFrames(camera, noFallback, clock.time, recorder().store, new AbortController().signal, clock)
    expect(result.failure).toBe('snapshot-unavailable')
    expect(result.snapshotMiss).toEqual({ reason: 'refused', slot: 1, remaining: 2, error: 'Motion detection is disabled for Front Door' })
    expect(result.frames).toHaveLength(1)
    expect(camera.streams).toEqual([])
  })

  it('falls back to one live stream for the remaining frames and removes its scratch directory', async () => {
    const clock = new FakeClock()
    const camera = new FakeCamera(1, 'Front Door')
    camera.snapshots.push(bytes(1), 'hang')
    camera.stream_ = { frames: [bytes(7), bytes(8)] }
    const { store, stored } = recorder()
    const t0 = clock.time
    const result = await captureFrames(camera, spec, t0, store, new AbortController().signal, clock)
    expect(result.failure).toBeUndefined()
    expect(result.snapshotMiss).toEqual({ reason: 'timeout', slot: 1, remaining: 2 })
    expect(result.frames.map(frame => frame.source)).toEqual(['snapshot', 'stream', 'stream'])
    expect(stored).toEqual([[0xff, 0xd8, 1], [0xff, 0xd8, 7], [0xff, 0xd8, 8]])
    const [options] = camera.streams
    expect(options?.audio).toEqual(['-an'])
    expect(options?.video).toEqual(['-vf', 'fps=1000/10000', '-q:v', '3'])
    expect(options?.output.slice(0, 4)).toEqual(['-frames:v', '2', '-f', 'image2'])
    const pattern = options?.output.at(-1) as string
    expect(pattern).toMatch(/dsh-camera-ring-.*\/frame-%02d\.jpg$/u)
    expect(existsSync(pattern.slice(0, pattern.lastIndexOf('/')))).toBe(false)
    const [, first, second] = result.frames
    expect((second?.offsetMs ?? 0) - (first?.offsetMs ?? 0)).toBe(10_000)
    expect(camera.stopped).toBe(1)
  })

  it('reports stream-failed when the stream yields fewer frames than missing', async () => {
    const clock = new FakeClock()
    const camera = new FakeCamera(1, 'Front Door')
    camera.snapshots.push(new Error('offline'))
    camera.stream_ = { frames: [bytes(7)] }
    const { store, firsts } = recorder()
    const result = await captureFrames(camera, spec, clock.time, store, new AbortController().signal, clock)
    expect(result.failure).toBe('stream-failed')
    expect(result.streamFailure).toEqual({ stage: 'ended-short', framesWritten: 1, framesRequested: 3 })
    expect(result.frames.map(frame => frame.source)).toEqual(['stream'])
    expect(firsts).toHaveLength(1)
    expect(firsts[0]).toMatch(/^sha256:0@\d+:stream$/u)
  })

  it('reports stream-failed when the live call is refused', async () => {
    const clock = new FakeClock()
    const camera = new FakeCamera(1, 'Front Door')
    camera.stream_ = { refuse: true }
    camera.snapshots.push(new Error('offline'))
    const result = await captureFrames(camera, spec, clock.time, recorder().store, new AbortController().signal, clock)
    expect(result).toEqual({
      frames: [], failure: 'stream-failed', snapshotMiss: { reason: 'refused', slot: 0, remaining: 3, error: 'offline' },
      streamFailure: { stage: 'start-refused', error: 'Live view is currently disabled' },
    })
  })

  it('stops a stream that starts only after the setup bound', async () => {
    const clock = new FakeClock()
    const camera = new FakeCamera(1, 'Front Door')
    let release: () => void = () => {}
    camera.stream_ = { hang: true, late: new Promise<void>((resolve) => { release = resolve }) }
    camera.snapshots.push(new Error('offline'))
    const result = await captureFrames(camera, spec, clock.time, recorder().store, new AbortController().signal, clock)
    expect(result).toEqual({ frames: [], failure: 'stream-failed', snapshotMiss: { reason: 'refused', slot: 0, remaining: 3, error: 'offline' }, streamFailure: { stage: 'start-timeout', boundMs: 20_000 } })
    release()
    await new Promise(resolve => setImmediate(resolve))
    expect(camera.stopped).toBe(1)
  })

  it('ignores a hung stream start that never resolves', async () => {
    const clock = new FakeClock()
    const camera = new FakeCamera(1, 'Front Door')
    camera.stream_ = { hang: true }
    camera.snapshots.push(new Error('offline'))
    await expect(captureFrames(camera, spec, clock.time, recorder().store, new AbortController().signal, clock))
      .resolves.toMatchObject({ frames: [], failure: 'stream-failed', streamFailure: { stage: 'start-timeout' } })
  })

  it('bounds a call that never ends and still reads what ffmpeg wrote', async () => {
    const clock = new FakeClock()
    const camera = new FakeCamera(1, 'Front Door')
    camera.snapshots.push(new Error('offline'))
    camera.stream_ = { frames: [bytes(5), bytes(6), bytes(7)], endless: true }
    const result = await captureFrames(camera, spec, clock.time, recorder().store, new AbortController().signal, clock)
    expect(result.failure).toBeUndefined()
    expect(result.frames).toHaveLength(3)
    expect(camera.stopped).toBe(1)
  })

  it('reports a stream stopped by the capture bound with the frames it wrote', async () => {
    const clock = new FakeClock()
    const camera = new FakeCamera(1, 'Front Door')
    camera.snapshots.push(new Error('offline'))
    camera.stream_ = { frames: [bytes(5)], endless: true }
    const result = await captureFrames(camera, spec, clock.time, recorder().store, new AbortController().signal, clock)
    expect(result).toMatchObject({ failure: 'stream-failed', frames: [{ source: 'stream' }] })
    expect(result.streamFailure).toEqual({ stage: 'run-timeout', framesWritten: 1, framesRequested: 3, boundMs: 50_000 })
    expect(camera.stopped).toBe(1)
  })

  it('reports a call that ended before ffmpeg wrote a frame', async () => {
    const clock = new FakeClock()
    const camera = new FakeCamera(1, 'Front Door')
    camera.snapshots.push(bytes(1), 'hang')
    camera.stream_ = { frames: [] }
    const result = await captureFrames(camera, spec, clock.time, recorder().store, new AbortController().signal, clock)
    expect(result.streamFailure).toEqual({ stage: 'ended-short', framesWritten: 0, framesRequested: 2 })
  })

  it('reports a storage refusal for a streamed frame', async () => {
    const clock = new FakeClock()
    const camera = new FakeCamera(1, 'Front Door')
    camera.snapshots.push(new Error('offline'))
    camera.stream_ = { frames: [bytes(5), bytes(6), bytes(7)] }
    const result = await captureFrames(camera, spec, clock.time, recorder(1).store, new AbortController().signal, clock)
    expect(result).toMatchObject({ failure: 'storage-failed', frames: [{ source: 'stream' }] })
  })

  it('stops on cancellation while waiting for the next slot', async () => {
    const clock = new FakeClock()
    const camera = new FakeCamera(1, 'Front Door')
    camera.snapshots.push(bytes(1), bytes(2))
    const controller = new AbortController()
    const capture = captureFrames(camera, spec, clock.time, {
      store: async () => {
        controller.abort(new Error('disposed'))
        return { attachmentId: AttachmentId('sha256:x'), mediaType: 'image/jpeg', bytes: 3, width: 8, height: 6 }
      },
      first: async () => {},
    }, controller.signal, clock)
    await expect(capture).rejects.toThrow('disposed')
  })

  it('stops a stream whose late start fails without leaking a rejection', async () => {
    const clock = new FakeClock()
    const camera = new FakeCamera(1, 'Front Door')
    let release: () => void = () => {}
    camera.stream_ = { hang: true, late: new Promise<void>((resolve) => { release = resolve }), lateFailure: true }
    camera.snapshots.push(new Error('offline'))
    const result = await captureFrames(camera, spec, clock.time, recorder().store, new AbortController().signal, clock)
    expect(result).toMatchObject({ frames: [], failure: 'stream-failed', streamFailure: { stage: 'start-timeout' } })
    release()
    await new Promise(resolve => setImmediate(resolve))
    expect(camera.stopped).toBe(0)
  })

  it('stops on cancellation during a snapshot or a stream', async () => {
    for (const script of ['snapshot', 'stream'] as const) {
      const clock = new FakeClock(15_000)
      const camera = new FakeCamera(1, 'Front Door')
      const controller = new AbortController()
      if (script === 'snapshot') camera.snapshots.push('hang')
      else {
        camera.snapshots.push(new Error('offline'))
        camera.stream_ = { frames: [], endless: true }
      }
      const capture = captureFrames(camera, spec, clock.time, recorder().store, controller.signal, clock)
      await new Promise(resolve => setTimeout(resolve, 5))
      controller.abort(new Error('disposed'))
      await expect(capture).rejects.toThrow('disposed')
    }
  })

  it('stops on cancellation during a hung stream start', async () => {
    const clock = new FakeClock(15_000)
    const camera = new FakeCamera(1, 'Front Door')
    camera.snapshots.push(new Error('offline'))
    camera.stream_ = { hang: true }
    const controller = new AbortController()
    const capture = captureFrames(camera, spec, clock.time, recorder().store, controller.signal, clock)
    await new Promise(resolve => setTimeout(resolve, 5))
    controller.abort(new Error('disposed'))
    await expect(capture).rejects.toThrow('disposed')
  })
})
