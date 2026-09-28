import { describe, expect, it } from 'vitest'
import { logDebug, logError, logInfo } from 'ring-client-api/util'
import { adaptRingApi, adaptRingCamera, createRingClient, RING_DING_CATEGORY, ringLogging } from '../src/client.ts'
import type { RingApiLike, RingCameraLike, RingPushShape, Subscribable } from '../src/client.ts'
import { wrappedToken } from './support.ts'

/** Minimal subject: replays nothing, fans out to current subscribers. */
class Subject<T> implements Subscribable<T> {
  readonly subscribers = new Set<(value: T) => void>()
  subscribe(next: (value: T) => void): { unsubscribe(): void } {
    this.subscribers.add(next)
    return { unsubscribe: () => { this.subscribers.delete(next) } }
  }
  next(value: T): void { for (const subscriber of this.subscribers) subscriber(value) }
}

function camera(): RingCameraLike & { pushes: Subject<RingPushShape>; ended: Subject<void>; stops: number; requests: unknown[] } {
  const pushes = new Subject<RingPushShape>()
  const ended = new Subject<void>()
  const fake = {
    id: 42, name: 'Front Door', onNewNotification: pushes, pushes, ended, stops: 0, requests: [] as unknown[],
    getSnapshot: async () => new Uint8Array([1, 2, 3]),
    streamVideo: async (options: { audio: string[]; video: string[]; output: string[] }) => {
      fake.requests.push(options)
      return { onCallEnded: ended, stop: () => { fake.stops++ } }
    },
  }
  return fake
}

describe('adaptRingCamera', () => {
  it('maps pushes, snapshots, and live streams to the provider surface', async () => {
    const source = camera()
    const handle = adaptRingCamera(source)
    expect([handle.id, handle.name]).toEqual([42, 'Front Door'])
    const seen: unknown[] = []
    const stop = handle.onNotification((notification) => { seen.push(notification) })
    source.pushes.next({ android_config: { category: RING_DING_CATEGORY }, data: { event: { ding: { id: '7000000000000000123' } } } })
    source.pushes.next({ android_config: { category: 'x' }, data: { event: { ding: { id: 5 } } } })
    stop()
    source.pushes.next({ android_config: { category: 'y' }, data: { event: { ding: { id: 6 } } } })
    expect(seen).toEqual([{ category: RING_DING_CATEGORY, dingId: '7000000000000000123' }, { category: 'x', dingId: '5' }])
    expect([...await handle.snapshot()]).toEqual([1, 2, 3])
    const stream = await handle.stream({ audio: ['-an'], video: ['-vf', 'fps=1'], output: ['out.jpg'] })
    expect(source.requests).toEqual([{ audio: ['-an'], video: ['-vf', 'fps=1'], output: ['out.jpg'] }])
    source.ended.next()
    await stream.ended
    stream.stop()
    expect(source.stops).toBe(1)
  })
})

describe('adaptRingApi', () => {
  it('lists cameras, forwards rotated tokens, and disconnects', async () => {
    const tokens = new Subject<{ newRefreshToken: string }>()
    let disconnects = 0
    const api: RingApiLike = { getCameras: async () => [camera()], onRefreshTokenUpdated: tokens, disconnect: () => { disconnects++ } }
    const client = adaptRingApi(api)
    expect((await client.cameras()).map(item => item.name)).toEqual(['Front Door'])
    const seen: string[] = []
    const stop = client.onRefreshToken((token) => { seen.push(token) })
    tokens.next({ newRefreshToken: 'rotated-1' })
    stop()
    tokens.next({ newRefreshToken: 'rotated-2' })
    client.disconnect()
    expect(seen).toEqual(['rotated-1'])
    expect(disconnects).toBe(1)
  })
})

describe('createRingClient', () => {
  it('constructs a ring-client-api connection without a network request', () => {
    for (const ffmpegPath of [undefined, '/usr/bin/ffmpeg']) {
      const client = createRingClient({ refreshToken: wrappedToken('synthetic-refresh-token'), controlCenterDisplayName: 'dsh test', ffmpegPath })
      const stop = client.onRefreshToken(() => {})
      stop()
      client.disconnect()
    }
  })
})

describe('ringLogging', () => {
  it('routes library errors and info lines to the installed sink until disposal', () => {
    const lines: string[] = []
    const sink = { error: (message: string) => { lines.push(`error ${message}`) }, info: (message: string) => { lines.push(`info ${message}`) } }
    const uninstall = ringLogging.install(sink)
    logError('Stream connection failed')
    logError(new Error('socket hang up'))
    logError({ type: 'error', code: 1006 })
    logInfo('From Ring (Front Door):', 'stopped gracefully')
    logDebug('hidden before debug is on')
    ringLogging.enableDebug()
    logDebug('frame=  1 fps=0.1')
    const replaced = ringLogging.install({ error: () => { lines.push('second') }, info: () => {} })
    uninstall()
    logError('still routed to the second sink')
    replaced()
    logError('dropped after disposal')
    logInfo('dropped after disposal')
    expect(lines).toEqual([
      'error Stream connection failed',
      'error socket hang up',
      "error { type: 'error', code: 1006 }",
      'info From Ring (Front Door): stopped gracefully',
      'info frame=  1 fps=0.1',
      'second',
    ])
  })
})
