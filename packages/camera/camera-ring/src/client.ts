/**
 * The narrow Ring surface the provider uses, and its adapter over `ring-client-api`. Tests replace
 * the factory; production constructs one `RingApi` per connection attempt.
 * @module @deepseek-ai/dsh-camera-ring/client
 */

import { inspect } from 'node:util'
import { RingApi } from 'ring-client-api'
import { enableDebug, useLogger } from 'ring-client-api/util'

/** Disposer that stops one subscription. */
export type Unsubscribe = () => void

/** Ring push categories for a doorbell press and a motion alert (vendor protocol constants). */
export const RING_DING_CATEGORY = 'com.ring.pn.live-event.ding'
/** Ring push category for a motion alert. */
export const RING_MOTION_CATEGORY = 'com.ring.pn.live-event.motion'

/** One device push notification, reduced to the fields event admission reads. */
export interface RingNotification {
  /** Vendor push category, such as {@link RING_DING_CATEGORY}. */
  readonly category: string
  /** Vendor event id; a repeated push carries the same id. */
  readonly dingId: string
}

/** ffmpeg argument groups for one live-stream capture. */
export interface RingStreamOptions {
  readonly audio: readonly string[]
  readonly video: readonly string[]
  readonly output: readonly string[]
}

/** One running live stream; `ended` settles when the transcoder exits or the call ends. */
export interface RingStreamHandle {
  readonly ended: Promise<void>
  /** End the call and its transcoder; safe after the stream ended. */
  stop(): void
}

/** One Ring camera or doorbell. */
export interface RingCameraHandle {
  /** Ring's numeric device id. */
  readonly id: number
  /** Device name set in the Ring app. */
  readonly name: string
  /**
   * Receive ding and motion pushes for this device.
   * @param listener - called once per received push.
   * @returns disposer for the subscription.
   */
  onNotification(listener: (notification: RingNotification) => void): Unsubscribe
  /**
   * Request a fresh snapshot.
   * @returns encoded JPEG bytes.
   */
  snapshot(): Promise<Uint8Array>
  /**
   * Start a live stream transcoded by the configured ffmpeg.
   * @param options - ffmpeg audio, video, and output arguments.
   * @returns the running stream after the transcoder started.
   */
  stream(options: RingStreamOptions): Promise<RingStreamHandle>
}

/** One authenticated Ring account connection. */
export interface RingClient {
  /**
   * List the account's cameras and start their push subscriptions.
   * @returns every camera visible to the account.
   */
  cameras(): Promise<readonly RingCameraHandle[]>
  /**
   * Receive every rotated refresh token, including push-credential updates.
   * @param listener - called with the complete new token.
   * @returns disposer for the subscription.
   */
  onRefreshToken(listener: (token: string) => void): Unsubscribe
  /** Close push, polling, and REST resources. */
  disconnect(): void
}

/** Inputs for one connection attempt. */
export interface RingClientOptions {
  /** Current refresh token, resolved from the credential reference for this attempt only. */
  readonly refreshToken: string
  /** Name Ring lists for this client among the account's authorized devices. */
  readonly controlCenterDisplayName: string
  /** Absolute ffmpeg executable for live-stream capture. */
  readonly ffmpegPath?: string | undefined
}

/** Connection seam: production uses {@link createRingClient}. */
export type RingClientFactory = (options: RingClientOptions) => RingClient

/** Minimal observable shape shared by rxjs subjects and test doubles. */
export interface Subscribable<T> {
  subscribe(next: (value: T) => void): { unsubscribe(): void }
}

/** The `ring-client-api` push fields read here. */
export interface RingPushShape {
  readonly android_config: { readonly category: string }
  readonly data: { readonly event: { readonly ding: { readonly id: string | number } } }
}

/** The `RingCamera` members the adapter uses. */
export interface RingCameraLike {
  readonly id: number
  readonly name: string
  readonly onNewNotification: Subscribable<RingPushShape>
  getSnapshot(): Promise<Uint8Array>
  streamVideo(options: { audio: string[]; video: string[]; output: string[] }): Promise<{
    readonly onCallEnded: Subscribable<void>
    stop(): void
  }>
}

/** The `RingApi` members the adapter uses. */
export interface RingApiLike {
  getCameras(): Promise<readonly RingCameraLike[]>
  readonly onRefreshTokenUpdated: Subscribable<{ readonly newRefreshToken: string }>
  disconnect(): void
}

/**
 * Adapt one `ring-client-api` camera to the provider surface.
 * @param camera - library camera.
 * @returns provider camera handle.
 */
export function adaptRingCamera(camera: RingCameraLike): RingCameraHandle {
  return {
    id: camera.id,
    name: camera.name,
    onNotification(listener) {
      const subscription = camera.onNewNotification.subscribe((push) => {
        listener({ category: push.android_config.category, dingId: String(push.data.event.ding.id) })
      })
      return () => { subscription.unsubscribe() }
    },
    snapshot: () => camera.getSnapshot(),
    async stream(options) {
      const session = await camera.streamVideo({ audio: [...options.audio], video: [...options.video], output: [...options.output] })
      const ended = new Promise<void>((resolve) => { session.onCallEnded.subscribe(() => { resolve() }) })
      return { ended, stop: () => { session.stop() } }
    },
  }
}

/**
 * Adapt one `ring-client-api` account connection to the provider surface.
 * @param api - library API instance.
 * @returns provider client.
 */
export function adaptRingApi(api: RingApiLike): RingClient {
  return {
    cameras: async () => (await api.getCameras()).map(adaptRingCamera),
    onRefreshToken(listener) {
      const subscription = api.onRefreshTokenUpdated.subscribe((update) => { listener(update.newRefreshToken) })
      return () => { subscription.unsubscribe() }
    },
    disconnect: () => { api.disconnect() },
  }
}

/**
 * Construct a `ring-client-api` connection. Construction performs no network request; the first
 * {@link RingClient.cameras} call authenticates, rotates the refresh token, and registers for pushes.
 * @param options - token, display name, and ffmpeg path.
 * @returns provider client.
 */
export function createRingClient(options: RingClientOptions): RingClient {
  return adaptRingApi(new RingApi({
    refreshToken: options.refreshToken,
    controlCenterDisplayName: options.controlCenterDisplayName,
    ...options.ffmpegPath === undefined ? {} : { ffmpegPath: options.ffmpegPath },
  }))
}

/** Where `ring-client-api` diagnostics go while a provider owns the library logger. */
export interface RingLogSink {
  /**
   * Receive one library error, such as a failed signalling socket or an ffmpeg exit code.
   * @param message - unredacted library text.
   */
  error(message: string): void
  /**
   * Receive one library info or debug line, including ffmpeg stderr when library debug is on.
   * @param message - unredacted library text.
   */
  info(message: string): void
}

/** Process-global `ring-client-api` logging controls. */
export interface RingLogging {
  /**
   * Route the library logger to `sink` until the returned disposer runs.
   * @param sink - receiver of library errors and info lines.
   * @returns disposer that silences the library logger when `sink` is still the installed one.
   */
  install(sink: RingLogSink): Unsubscribe
  /** Turn on the library's debug lines for the rest of the process; the library offers no way to turn them off. */
  enableDebug(): void
}

function vendorText(value: unknown): string {
  if (typeof value === 'string') return value
  return value instanceof Error ? value.message : inspect(value, { depth: 2, breakLength: Number.POSITIVE_INFINITY })
}

/** The sink whose logger `ring-client-api` currently calls, if any. */
let installedSink: RingLogSink | undefined

/**
 * Production {@link RingLogging} over `ring-client-api/util`. The library keeps one logger per
 * process and exposes no way to read its default, so the disposer installs a logger that drops
 * every line; the default wrote only to the `ring` debug namespace.
 */
export const ringLogging: RingLogging = {
  install(sink) {
    installedSink = sink
    useLogger({
      logInfo: (...message: unknown[]) => { sink.info(message.map(vendorText).join(' ')) },
      logError: (message: unknown) => { sink.error(vendorText(message)) },
    })
    return () => {
      if (installedSink !== sink) return
      installedSink = undefined
      useLogger({ logInfo: () => {}, logError: () => {} })
    }
  },
  enableDebug: () => { enableDebug() },
}
