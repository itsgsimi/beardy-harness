import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import type { CameraEvent, CameraPreview } from '@deepseek-ai/dsh-camera'
import RingCameraService, {
  describeSnapshotMiss, describeStreamFailure, RING_DING_CATEGORY, RING_MOTION_CATEGORY, redact, resolveSpec, tokenSecrets,
} from '../src/index.ts'
import type { Config, RingProviderDeps } from '../src/index.ts'
import { FakeCamera, FakeClock, FakeCredentials, FakeLogging, FakeRing, jpeg, until, wrappedToken } from './support.ts'

const REF = 'RING_REFRESH_TOKEN'
const INNER = 'inner-refresh-secret-0001'
const TOKEN = wrappedToken(INNER)

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const baseConfig = {
  refreshTokenRef: REF,
  devices: [
    { id: 'front-door', label: 'Front door', ringName: 'front door' },
    { id: 'garage', label: 'Garage', ringId: 202 },
  ],
  streamFallback: false,
} satisfies Config

interface Harness {
  readonly ctx: Context
  readonly ring: FakeRing
  readonly front: FakeCamera
  readonly garage: FakeCamera
  readonly credentials: FakeCredentials
  readonly clock: FakeClock
  readonly events: CameraEvent[]
  /** Previews in publication order, each tagged with how many complete events preceded it. */
  readonly previews: { readonly preview: CameraPreview; readonly eventsBefore: number }[]
  readonly logs: { type: string; text: string }[]
  readonly logging: FakeLogging
  readonly load: Promise<unknown>
}

async function harness(config: Partial<Config> = {}, options: {
  credentials?: (credentials: FakeCredentials) => void
  ring?: (ring: FakeRing) => void
  realExecutableCheck?: boolean
  clock?: FakeClock
} = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-camera-ring-test-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  const logs: { type: string; text: string }[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logs.push({ type: message.type, text: message.args.map(String).join(' ') }) } })
  await ctx.plugin(LocalAttachmentStore, { dshHome: root })
  const credentials = new FakeCredentials()
  credentials.values.set(REF, TOKEN)
  options.credentials?.(credentials)
  ctx.provide('credentials', credentials as never)
  const ring = new FakeRing()
  const front = new FakeCamera(101, 'Front Door')
  const garage = new FakeCamera(202, 'Garage')
  ring.cameras = [front, garage]
  options.ring?.(ring)
  const clock = options.clock ?? new FakeClock()
  const events: CameraEvent[] = []
  const previews: Harness['previews'][number][] = []
  ctx.on('camera/event', (event) => { events.push(event) })
  ctx.on('camera/preview', (preview) => { previews.push({ preview, eventsBefore: events.length }) })
  const logging = new FakeLogging()
  const deps: RingProviderDeps = {
    connect: ring.connect, now: clock.now, sleep: clock.sleep, logging,
    ...options.realExecutableCheck === true ? {} : { checkExecutable: async () => {} },
  }
  class TestRing extends RingCameraService {
    constructor(context: Context, value: Config) { super(context, value, deps) }
  }
  const load: Promise<unknown> = Promise.resolve(ctx.plugin(TestRing, { ...baseConfig, ...config }))
  return { ctx, ring, front, garage, credentials, clock, events, previews, logs, logging, load }
}

async function started(config: Partial<Config> = {}, options: Parameters<typeof harness>[1] = {}): Promise<Harness> {
  const value = await harness(config, options)
  await value.load
  await until(() => value.front.listeners.size === 1 || value.logs.some(log => log.type === 'error'), 'Ring subscriptions')
  return value
}

describe('resolveSpec', () => {
  it('applies defaults and keeps ffmpeg only for the stream fallback', () => {
    const spec = resolveSpec({ refreshTokenRef: REF, devices: [{ id: 'front-door', label: ' Front door ', ringName: ' Front Door ' }], ffmpegPath: '/usr/bin/ffmpeg' })
    expect(spec).toMatchObject({
      events: ['motion', 'ding'], frameCount: 3, frameIntervalMs: 10_000, snapshotTimeoutMs: 20_000, streamFallback: true,
      ffmpegPath: '/usr/bin/ffmpeg', streamSetupMs: 20_000, motionCooldownMs: 120_000, dingCooldownMs: 30_000,
      dedupeWindowMs: 600_000, dedupeMaxIds: 500, reconnectDelayMs: 5_000, maxReconnectDelayMs: 600_000,
      controlCenterDisplayName: 'dsh-camera-ring', vendorDebug: false, devices: [{ id: 'front-door', label: 'Front door', match: { kind: 'name', name: 'Front Door' } }],
    })
    const explicit = resolveSpec({ ...baseConfig, events: ['ding', 'ding'], frameCount: 2, frameIntervalMs: 5_000, snapshotTimeoutMs: 4_000,
      ffmpegPath: '/ignored', streamSetupMs: 9_000, motionCooldownMs: 1, dingCooldownMs: 2, dedupeWindowMs: 3_000, dedupeMaxIds: 4,
      reconnectDelayMs: 6_000, maxReconnectDelayMs: 7_000, controlCenterDisplayName: 'beardy', vendorDebug: true })
    expect(explicit).toMatchObject({
      events: ['ding'], frameCount: 2, streamFallback: false, reconnectDelayMs: 6_000, controlCenterDisplayName: 'beardy', vendorDebug: true,
    })
    expect(explicit.ffmpegPath).toBeUndefined()
  })

  it.each([
    [{ refreshTokenRef: 'ring token' }, /refreshTokenRef/],
    [{ devices: [] }, /at least one device/],
    [{ devices: [{ id: 'a', label: 'A', ringId: 1 }, { id: 'a', label: 'B', ringId: 2 }] }, /configured twice/],
    [{ devices: [{ id: 'a', label: ' ', ringId: 1 }] }, /label of 1 to 60/],
    [{ devices: [{ id: 'a', label: 'x'.repeat(61), ringId: 1 }] }, /label of 1 to 60/],
    [{ devices: [{ id: 'a', label: 'A', ringId: 1, ringName: 'A' }] }, /exactly one of ringId or ringName/],
    [{ devices: [{ id: 'a', label: 'A' }] }, /exactly one of ringId or ringName/],
    [{ devices: [{ id: 'a', label: 'A', ringName: ' ' }] }, /exactly one of ringId or ringName/],
    [{ devices: [{ id: 'Front', label: 'A', ringId: 1 }] }, /camera device id/],
    [{ events: [] }, /at least one event kind/],
    [{ streamFallback: true }, /ffmpegPath must be an absolute/],
    [{ streamFallback: true, ffmpegPath: 'ffmpeg' }, /ffmpegPath must be an absolute/],
    [{ reconnectDelayMs: 10_000, maxReconnectDelayMs: 5_000 }, /must not exceed/],
  ] as [Partial<Config>, RegExp][])('rejects %j', (override, message) => {
    expect(() => resolveSpec({ ...baseConfig, ...override })).toThrow(message)
  })
})

describe('token redaction', () => {
  it('names the wrapped token and its inner refresh token', () => {
    expect(tokenSecrets(TOKEN)).toEqual([TOKEN, INNER])
    expect(tokenSecrets('not-base64-json-token')).toEqual(['not-base64-json-token'])
    expect(tokenSecrets(Buffer.from(JSON.stringify({ rt: 5 })).toString('base64'))).toHaveLength(1)
    expect(tokenSecrets(Buffer.from('null').toString('base64'))).toEqual(['bnVsbA=='])
    expect(tokenSecrets('short')).toEqual([])
    expect(redact(`failed with ${TOKEN} and ${INNER}`, tokenSecrets(TOKEN))).toBe('failed with [redacted] and [redacted]')
    expect(redact('x'.repeat(400), [])).toHaveLength(300)
  })
})

describe('RingCameraService startup', () => {
  it('refuses to load without a stored token', async () => {
    const value = await harness({}, { credentials: (credentials) => { credentials.values.clear() } })
    await expect(value.load).rejects.toThrow(`credential ${REF} is not configured`)
  })

  it('refuses a token it could not write back', async () => {
    for (const source of ['env', undefined]) {
      const value = await harness({}, { credentials: (credentials) => {
        credentials.writable = false
        if (source === undefined) credentials.values.clear()
        else credentials.source = source
      } })
      if (source === undefined) await expect(value.load).rejects.toThrow('is not configured')
      else await expect(value.load).rejects.toThrow('comes from a read-only source (env)')
    }
    const unknown = await harness({}, { credentials: (credentials) => {
      credentials.writable = false
      credentials.describe = async () => ({ configured: true, writable: false })
    } })
    await expect(unknown.load).rejects.toThrow('read-only source (unknown)')
  })

  it('checks the ffmpeg executable when the stream fallback is on', async () => {
    const valid = await harness({ streamFallback: true, ffmpegPath: process.execPath }, { realExecutableCheck: true })
    await expect(valid.load).resolves.toBeDefined()
    const directory = await harness({ streamFallback: true, ffmpegPath: tmpdir() }, { realExecutableCheck: true })
    await expect(directory.load).rejects.toThrow(`ffmpegPath ${tmpdir()} is not an executable file`)
    const missing = await harness({ streamFallback: true, ffmpegPath: '/nonexistent/ffmpeg' }, { realExecutableCheck: true })
    await expect(missing.load).rejects.toThrow('is not an executable file')
  })

  it('connects with the stored token and watches devices matched by name or id', async () => {
    const value = await started({ controlCenterDisplayName: 'beardy-camera' })
    expect(value.ring.options).toEqual([{ refreshToken: TOKEN, controlCenterDisplayName: 'beardy-camera', ffmpegPath: undefined }])
    expect([value.front.listeners.size, value.garage.listeners.size]).toEqual([1, 1])
    expect(value.ctx.camera.devices()).toEqual([{ id: 'front-door', label: 'Front door' }, { id: 'garage', label: 'Garage' }])
    expect(value.logs.map(log => log.text)).toContain('camera-ring: watching 2 Ring device(s)')
  })

  it('names every account device when a configured device is missing, and does not retry', async () => {
    const value = await started({ devices: [{ id: 'side', label: 'Side', ringName: 'Side Gate' }, { id: 'shed', label: 'Shed', ringId: 9 }] })
    expect(value.logs.filter(log => log.type === 'error').map(log => log.text)).toEqual([
      'camera-ring: no Ring device matches "Side Gate", 9; the account has "Front Door" (101), "Garage" (202)',
    ])
    expect(value.ring.options).toHaveLength(1)
    expect(value.ring.disconnects).toBe(1)
    const empty = await started({}, { ring: (ring) => { ring.cameras = [] } })
    expect(empty.logs.find(log => log.type === 'error')?.text).toContain('the account has no cameras')
  })

  it('retries a failed connection with a doubling delay and never logs the token', async () => {
    const value = await started({ reconnectDelayMs: 1_000, maxReconnectDelayMs: 1_500 }, { ring: (ring) => {
      ring.failures.push(new Error(`401 for refresh_token=${INNER}`), new Error(`oauth rejected ${TOKEN}`))
    } })
    expect(value.ring.options).toHaveLength(3)
    expect(value.clock.sleeps.slice(0, 2)).toEqual([1_000, 1_500])
    const warnings = value.logs.filter(log => log.type === 'warn').map(log => log.text)
    expect(warnings).toEqual([
      'camera-ring: Ring connection failed; retrying in 1000 ms: 401 for refresh_token=[redacted]',
      'camera-ring: Ring connection failed; retrying in 1500 ms: oauth rejected [redacted]',
    ])
    expect(JSON.stringify(value.logs)).not.toContain(INNER)
  })

  it('reports a non-Error connection failure', async () => {
    const value = await started({}, { ring: (ring) => { ring.failures.push('socket closed') } })
    expect(value.logs.some(log => log.text.endsWith('retrying in 5000 ms: socket closed'))).toBe(true)
  })

  it('uses the real clock and delay when none are injected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-camera-ring-clock-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LocalAttachmentStore, { dshHome: root })
    const credentials = new FakeCredentials()
    credentials.values.set(REF, TOKEN)
    ctx.provide('credentials', credentials as never)
    const ring = new FakeRing()
    ring.failures.push(new Error('network down'))
    class RealClockRing extends RingCameraService {
      constructor(context: Context, value: Config) { super(context, value, { connect: ring.connect }) }
    }
    await ctx.plugin(RealClockRing, baseConfig)
    await until(() => ring.options.length === 1, 'first attempt')
    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)
    expect(ring.options).toHaveLength(1)
  })

  it('keeps the production connection factory until a connection is attempted', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const credentials = new FakeCredentials()
    ctx.provide('credentials', credentials as never)
    ctx.provide('attachments', {} as never)
    await expect(ctx.plugin(RingCameraService, baseConfig)).rejects.toThrow('is not configured')
  })

  it('retries when the token disappears between checks', async () => {
    let reads = 0
    const value = await harness({}, { credentials: (credentials) => {
      const resolve = credentials.resolve
      credentials.resolve = async ref => (++reads === 1 ? undefined : await resolve(ref))
    } })
    await value.load
    await until(() => value.front.listeners.size === 1, 'second connection')
    expect(value.logs.some(log => log.text.includes(`credential ${REF} is not configured`))).toBe(true)
  })
})

describe('RingCameraService events', () => {
  it('captures a frame set for a doorbell press and publishes it once per vendor event', async () => {
    const value = await started({ frameCount: 2, frameIntervalMs: 1_000 })
    value.front.snapshots.push(await jpeg(10), await jpeg(200))
    value.front.push(RING_DING_CATEGORY, '7001')
    value.front.push(RING_DING_CATEGORY, '7001')
    await until(() => value.events.length === 1, 'published event')
    const [event] = value.events
    expect(event).toMatchObject({ id: 'ring-101-7001', deviceId: 'front-door', kind: 'ding', occurredAt: Date.UTC(2026, 8, 27, 4, 0) })
    expect(event?.frames.map(frame => [frame.source, frame.offsetMs, frame.attachment.mediaType, frame.attachment.name]))
      .toEqual([['snapshot', 0, 'image/jpeg', 'front-door-1.jpg'], ['snapshot', 1_000, 'image/jpeg', 'front-door-2.jpg']])
    expect(event?.captureFailure).toBeUndefined()
    const stored = await value.ctx.attachments.readImage(event!.frames[0]!.attachment)
    expect(stored.data.length).toBeGreaterThan(0)
    expect(value.front.snapshotCalls).toBe(2)
    expect(value.previews).toEqual([{
      preview: { id: 'ring-101-7001', deviceId: 'front-door', kind: 'ding', occurredAt: Date.UTC(2026, 8, 27, 4, 0), frame: event!.frames[0] },
      eventsBefore: 0,
    }])
  })

  it('reports a capture shortfall on the event', async () => {
    const value = await started({ frameCount: 2 })
    value.garage.snapshots.push(new Error('Motion detection is disabled'))
    value.garage.push(RING_MOTION_CATEGORY, '8')
    await until(() => value.events.length === 1, 'published event')
    expect(value.events[0]).toMatchObject({ kind: 'motion', deviceId: 'garage', frames: [], captureFailure: 'snapshot-unavailable' })
    expect(value.previews).toEqual([])
  })

  it('ignores other categories and kinds outside the configured events', async () => {
    const value = await started({ events: ['ding'], frameCount: 1 })
    value.front.push(RING_MOTION_CATEGORY, '1')
    value.front.push('com.ring.pn.live-event.intercom', '2')
    value.front.snapshots.push(await jpeg(1))
    value.front.push(RING_DING_CATEGORY, '3')
    await until(() => value.events.length === 1, 'ding event')
    expect(value.events.map(event => event.id)).toEqual(['ring-101-3'])
  })

  it('applies per-device, per-kind cooldowns and drops motion that overlaps a capture', async () => {
    const value = await started({ frameCount: 1, motionCooldownMs: 60_000, dingCooldownMs: 5_000 })
    value.front.snapshots.push('hang')
    value.front.push(RING_MOTION_CATEGORY, 'm1')
    value.front.push(RING_MOTION_CATEGORY, 'm2')
    value.clock.time += 61_000
    value.front.push(RING_MOTION_CATEGORY, 'm3')
    value.front.snapshots.push(await jpeg(3))
    value.front.push(RING_DING_CATEGORY, 'd1')
    value.front.push(RING_DING_CATEGORY, 'd2')
    value.garage.snapshots.push(await jpeg(4))
    value.garage.push(RING_MOTION_CATEGORY, 'g1')
    await until(() => value.events.length === 3, 'three events')
    expect(value.events.map(event => event.id).sort()).toEqual(['ring-101-d1', 'ring-101-m1', 'ring-202-g1'])
    value.clock.time += 6_000
    value.front.snapshots.push(await jpeg(5))
    value.front.push(RING_DING_CATEGORY, 'd3')
    await until(() => value.events.length === 4, 'ding after cooldown')
  })

  it('forgets vendor ids after the dedupe window and beyond the id bound', async () => {
    const value = await started({ frameCount: 1, dingCooldownMs: 0, dedupeWindowMs: 1_000, dedupeMaxIds: 2 })
    for (const id of ['a', 'b', 'c']) {
      value.front.snapshots.push(await jpeg(id.charCodeAt(0)))
      value.front.push(RING_DING_CATEGORY, id)
      await until(() => value.events.length === ['a', 'b', 'c'].indexOf(id) + 1, `event ${id}`)
    }
    value.front.snapshots.push(await jpeg(9))
    value.front.push(RING_DING_CATEGORY, 'a')
    await until(() => value.events.length === 4, 'bound eviction')
    value.clock.time += 2_000
    value.front.snapshots.push(await jpeg(8))
    value.front.push(RING_DING_CATEGORY, 'c')
    await until(() => value.events.length === 5, 'window expiry')
  })

  it('makes an event id from an unusual or empty vendor id', async () => {
    const value = await started({ frameCount: 1, dingCooldownMs: 0 })
    value.front.snapshots.push(await jpeg(1), await jpeg(2))
    value.front.push(RING_DING_CATEGORY, 'a b/c')
    value.front.push(RING_DING_CATEGORY, '')
    await until(() => value.events.length === 2, 'two events')
    expect(value.events.map(event => event.id)).toEqual(['ring-101-a-b-c', `ring-101-${String(Date.UTC(2026, 8, 27, 4, 0))}`])
  })

  it('logs a capture that fails outright without stopping later events', async () => {
    const value = await started({ frameCount: 1, streamFallback: true, ffmpegPath: '/usr/bin/ffmpeg', dingCooldownMs: 0 })
    value.front.snapshots.push(new Error('offline'))
    value.front.stream = () => { throw new Error(`stream refused for ${TOKEN}`) }
    value.front.push(RING_DING_CATEGORY, 'x')
    await until(() => value.logs.some(log => log.text.startsWith('camera-ring: capture for ring-101-x failed')), 'capture failure')
    expect(value.logs.find(log => log.text.startsWith('camera-ring: capture for'))?.text)
      .toBe('camera-ring: capture for ring-101-x failed: stream refused for [redacted]')
    expect(value.events).toEqual([])
  })
})

describe('RingCameraService capture diagnostics', () => {
  const streaming = { streamFallback: true, ffmpegPath: '/usr/bin/ffmpeg', dingCooldownMs: 0 } satisfies Partial<Config>

  it('describes each snapshot miss and stream failure stage', () => {
    expect(describeSnapshotMiss({ reason: 'stale', slot: 1, remaining: 2 }, true)).toBe('repeated the previous snapshot; streaming the remaining 2 frame(s)')
    expect(describeSnapshotMiss({ reason: 'timeout', slot: 0, remaining: 3 }, false)).toBe('timed out; stream fallback is off')
    expect(describeSnapshotMiss({ reason: 'refused', slot: 0, remaining: 3, error: 'offline' }, true)).toBe('was refused: offline; streaming the remaining 3 frame(s)')
    expect(describeStreamFailure({ stage: 'start-refused', error: 'Live view is currently disabled' })).toBe('Live view is currently disabled')
    expect(describeStreamFailure({ stage: 'start-timeout', boundMs: 20_000 })).toBe('no stream within 20000 ms')
    expect(describeStreamFailure({ stage: 'ended-short', framesWritten: 0, framesRequested: 2 })).toBe('the call ended with 0 of 2 frame(s) written')
    expect(describeStreamFailure({ stage: 'run-timeout', framesWritten: 1, framesRequested: 3, boundMs: 50_000 }))
      .toBe('stopped at the 50000 ms bound with 1 of 3 frame(s) written')
  })

  it('logs the snapshot that moved capture to the stream and where the stream failed, without the token', async () => {
    const value = await started({ ...streaming, frameCount: 3 })
    value.front.snapshots.push(await jpeg(1), new Error(`snapshot refused for ${INNER}`))
    value.front.stream_ = { refuse: true }
    value.front.stream = async () => { throw new Error(`Live view is currently disabled; token ${TOKEN}`) }
    value.front.push(RING_DING_CATEGORY, 'r1')
    await until(() => value.events.length === 1, 'published event')
    expect(value.events[0]?.captureFailure).toBe('stream-failed')
    expect(value.logs.filter(log => log.text.includes('ring-101-r1'))).toEqual([
      { type: 'info', text: 'camera-ring: snapshot 2 for ring-101-r1 was refused: snapshot refused for [redacted]; streaming the remaining 2 frame(s)' },
      { type: 'warn', text: 'camera-ring: stream capture for ring-101-r1 failed at start-refused: Live view is currently disabled; token [redacted]' },
    ])
  })

  it('logs a stream that ended short and a stale snapshot with the fallback off', async () => {
    const value = await started({ ...streaming, frameCount: 2 })
    value.front.snapshots.push(new Error('offline'))
    value.front.stream_ = { frames: [await jpeg(5)] }
    value.front.push(RING_DING_CATEGORY, 's1')
    await until(() => value.events.length === 1, 'streamed event')
    expect(value.logs.find(log => log.type === 'warn')?.text)
      .toBe('camera-ring: stream capture for ring-101-s1 failed at ended-short: the call ended with 1 of 2 frame(s) written')
    const plain = await started({ frameCount: 2 })
    plain.front.snapshots.push(await jpeg(1), await jpeg(1))
    plain.front.push(RING_DING_CATEGORY, 's2')
    await until(() => plain.events.length === 1, 'stale event')
    expect(plain.events[0]?.captureFailure).toBe('snapshot-stale')
    expect(plain.logs.filter(log => log.text.includes('ring-101-s2')).map(log => log.text))
      .toEqual(['camera-ring: snapshot 2 for ring-101-s2 repeated the previous snapshot; stream fallback is off'])
  })
})

describe('RingCameraService vendor logger', () => {
  it('routes ring-client-api errors to warn and info lines to debug, redacted, until disposal', async () => {
    const value = await started()
    expect([value.logging.installs, value.logging.debugEnabled]).toEqual([1, false])
    value.logging.sink?.error(`From Ring (Front Door): exited with code 1 and signal null; ${INNER}`)
    value.logging.sink?.info(`WebSocket opened for ${TOKEN}`)
    expect(value.logs.filter(log => log.text.startsWith('camera-ring: ring-client-api:'))).toEqual([
      { type: 'warn', text: 'camera-ring: ring-client-api: From Ring (Front Door): exited with code 1 and signal null; [redacted]' },
      { type: 'debug', text: 'camera-ring: ring-client-api: WebSocket opened for [redacted]' },
    ])
    await value.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(value.ctx), 1)
    expect(value.logging.uninstalls).toBe(1)
  })

  it('turns on library debug and logs its lines at info when vendorDebug is set', async () => {
    const value = await started({ vendorDebug: true })
    expect(value.logging.debugEnabled).toBe(true)
    value.logging.sink?.info('From Ring (Front Door): frame=    1 fps=0.1')
    expect(value.logs.find(log => log.text.startsWith('camera-ring: ring-client-api:')))
      .toEqual({ type: 'info', text: 'camera-ring: ring-client-api: From Ring (Front Door): frame=    1 fps=0.1' })
  })
})

describe('RingCameraService token rotation', () => {
  it('writes every rotated token through the credential reference in order', async () => {
    const value = await started()
    const second = wrappedToken('inner-refresh-secret-0002')
    const third = wrappedToken('inner-refresh-secret-0003')
    value.ring.rotate(second)
    value.ring.rotate(third)
    await until(() => value.credentials.writes.length === 2, 'token writes')
    expect(value.credentials.writes).toEqual([[REF, second], [REF, third]])
    expect(value.credentials.values.get(REF)).toBe(third)
    const text = JSON.stringify(value.logs)
    for (const secret of [TOKEN, INNER, second, third, 'inner-refresh-secret-0002']) expect(text).not.toContain(secret)
    expect(value.logs.filter(log => log.text === `camera-ring: stored the rotated Ring refresh token in ${REF}`)).toHaveLength(2)
  })

  it('reports a failed write without the token', async () => {
    const value = await started()
    value.credentials.failWrites = true
    const next = wrappedToken('inner-refresh-secret-0004')
    value.ring.rotate(next)
    await until(() => value.logs.some(log => log.text.includes('could not be stored')), 'write failure')
    expect(value.logs.find(log => log.text.includes('could not be stored'))?.text)
      .toBe('camera-ring: the rotated Ring refresh token could not be stored: could not write [redacted] to the store')
  })
})

describe('RingCameraService disposal', () => {
  it('stops captures, subscriptions, and the connection, and ignores later pushes', async () => {
    const value = await started({ frameCount: 2, frameIntervalMs: 50_000 }, { clock: new FakeClock(40_000) })
    value.front.snapshots.push(await jpeg(1))
    value.front.push(RING_DING_CATEGORY, 'slow')
    await until(() => value.front.snapshotCalls === 1, 'first snapshot')
    const listeners = [...value.front.listeners]
    await value.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(value.ctx), 1)
    for (const listener of listeners) listener({ category: RING_DING_CATEGORY, dingId: 'late' })
    expect(value.events).toEqual([])
    expect(value.front.listeners.size).toBe(0)
    expect(value.ring.disconnects).toBe(1)
  })

  it('stops a reconnect wait on disposal', async () => {
    const value = await harness({ reconnectDelayMs: 90_000 }, { clock: new FakeClock(60_000), ring: (ring) => { ring.failures.push(new Error('network down')) } })
    await value.load
    await until(() => value.clock.sleeps.includes(90_000), 'reconnect wait')
    await value.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(value.ctx), 1)
    expect(value.ring.options).toHaveLength(1)
  })

  it('discards a connection that finishes after disposal', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const value = await harness({}, { ring: (ring) => {
      const connect = ring.connect
      Object.assign(ring, { connect: (options: Parameters<typeof connect>[0]) => {
        const client = connect(options)
        return { ...client, cameras: async () => { await gate; return await client.cameras() } }
      } })
    } })
    await value.load
    await until(() => value.ring.options.length === 1, 'connection start')
    const disposing = value.ctx.fiber.dispose()
    release()
    await disposing
    contexts.splice(contexts.indexOf(value.ctx), 1)
    expect(value.front.listeners.size).toBe(0)
  })
})
