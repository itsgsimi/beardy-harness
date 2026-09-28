/** Fake Ring account, cameras, credentials, and clock for provider tests. No network is used. */

import { writeFileSync } from 'node:fs'
import sharp from 'sharp'
import type {
  RingCameraHandle, RingClient, RingClientOptions, RingLogging, RingLogSink, RingNotification, RingStreamHandle, RingStreamOptions,
} from '../src/client.ts'

/**
 * Encode a synthetic solid-colour JPEG.
 * @param shade - red channel value, so frames differ.
 * @returns JPEG bytes.
 */
export async function jpeg(shade: number): Promise<Uint8Array> {
  const image = sharp({ create: { width: 8, height: 6, channels: 3, background: { r: shade, g: 40, b: 90 } } })
  return new Uint8Array(await image.jpeg().toBuffer())
}

/** One scripted snapshot reply. */
export type SnapshotReply = Uint8Array | Error | 'hang'

/** How the fake live stream behaves. */
export interface StreamScript {
  /** Frames written to ffmpeg's output pattern before the call ends. */
  readonly frames?: readonly Uint8Array[]
  /** Reject the start. */
  readonly refuse?: boolean
  /** Never start; with `late`, start after the capture gave up. */
  readonly hang?: boolean
  /** Resolve a hung start after this promise settles. */
  readonly late?: Promise<void>
  /** Reject the late start instead of resolving it. */
  readonly lateFailure?: boolean
  /** Never end the call. */
  readonly endless?: boolean
}

/** Scriptable Ring camera. */
export class FakeCamera implements RingCameraHandle {
  readonly listeners = new Set<(notification: RingNotification) => void>()
  readonly snapshots: SnapshotReply[] = []
  readonly streams: RingStreamOptions[] = []
  stopped = 0
  stream_: StreamScript = {}
  snapshotCalls = 0

  constructor(readonly id: number, readonly name: string) {}

  onNotification(listener: (notification: RingNotification) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  snapshot(): Promise<Uint8Array> {
    this.snapshotCalls++
    const next = this.snapshots.shift()
    if (next === undefined || next === 'hang') return new Promise<Uint8Array>(() => {})
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
  }

  async stream(options: RingStreamOptions): Promise<RingStreamHandle> {
    this.streams.push(options)
    const script = this.stream_
    const handle = (): RingStreamHandle => ({
      ended: script.endless === true ? new Promise<void>(() => {}) : Promise.resolve(),
      stop: () => { this.stopped++ },
    })
    if (script.refuse === true) throw new Error('Live view is currently disabled')
    if (script.hang === true) {
      if (script.late === undefined) return await new Promise<RingStreamHandle>(() => {})
      await script.late
      if (script.lateFailure === true) throw new Error('call ended before answer')
      return handle()
    }
    const pattern = options.output.at(-1) as string
    for (const [index, frame] of (script.frames ?? []).entries()) {
      writeFileSync(pattern.replace('%02d', String(index + 1).padStart(2, '0')), frame)
    }
    return handle()
  }

  /**
   * Deliver one push to every subscriber.
   * @param category - vendor push category.
   * @param dingId - vendor event id.
   */
  push(category: string, dingId: string): void {
    for (const listener of this.listeners) listener({ category, dingId })
  }
}

/** Scriptable account connection factory. */
export class FakeRing {
  readonly options: RingClientOptions[] = []
  readonly tokenListeners = new Set<(token: string) => void>()
  cameras: FakeCamera[] = []
  failures: unknown[] = []
  disconnects = 0

  readonly connect = (options: RingClientOptions): RingClient => {
    this.options.push(options)
    const failure = this.failures.shift()
    return {
      cameras: async () => {
        if (failure !== undefined) throw failure
        return this.cameras
      },
      onRefreshToken: (listener) => {
        this.tokenListeners.add(listener)
        return () => { this.tokenListeners.delete(listener) }
      },
      disconnect: () => { this.disconnects++ },
    }
  }

  /**
   * Emit one rotated token.
   * @param token - new wrapped token.
   */
  rotate(token: string): void {
    for (const listener of this.tokenListeners) listener(token)
  }
}

/** In-memory credential service with a configurable source. */
export class FakeCredentials {
  values = new Map<string, string>()
  writable = true
  source = 'file'
  readonly writes: [string, string][] = []
  failWrites = false

  describe = async (ref: string) => ({
    configured: this.values.has(ref), writable: this.writable,
    ...this.values.has(ref) ? { source: this.source } : {},
  })

  resolve = async (ref: string) => {
    const value = this.values.get(ref)
    return value === undefined ? undefined : { value, source: this.source }
  }

  set = async (ref: string, value: string) => {
    if (this.failWrites) throw new Error(`could not write ${value} to the store`)
    this.writes.push([ref, value])
    this.values.set(ref, value)
  }
}

/**
 * Wrap a Ring refresh token the way ring-client-api does.
 * @param rt - inner refresh token.
 * @returns base64 JSON token.
 */
export function wrappedToken(rt: string): string {
  return Buffer.from(JSON.stringify({ rt, hid: 'fixture-hardware-id' })).toString('base64')
}

/** Controllable clock: every sleep advances time after one macrotask; sleeps of `holdFrom` or more wait for abort. */
export class FakeClock {
  time = Date.UTC(2026, 8, 27, 4, 0)
  readonly sleeps: number[] = []

  constructor(private readonly holdFrom = Number.POSITIVE_INFINITY) {}

  now = (): number => this.time

  sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise<void>((resolve, reject) => {
    const reason = (): Error => signal.reason instanceof Error ? signal.reason : new Error('sleep aborted')
    if (signal.aborted) {
      reject(reason())
      return
    }
    this.sleeps.push(ms)
    const timer = ms >= this.holdFrom ? undefined : setImmediate(() => {
      signal.removeEventListener('abort', abort)
      this.time += ms
      resolve()
    })
    const abort = (): void => {
      if (timer !== undefined) clearImmediate(timer)
      reject(reason())
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

/**
 * Wait until a condition holds, polling across macrotasks.
 * @param check - condition to wait for.
 * @param label - failure description.
 */
export async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Recording stand-in for the process-global `ring-client-api` logger. */
export class FakeLogging implements RingLogging {
  sink: RingLogSink | undefined
  installs = 0
  uninstalls = 0
  debugEnabled = false

  install(sink: RingLogSink): () => void {
    this.installs++
    this.sink = sink
    return () => {
      this.uninstalls++
      this.sink = undefined
    }
  }

  enableDebug(): void { this.debugEnabled = true }
}
