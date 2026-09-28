/**
 * The narrow Ring surface the provider uses, and its adapter over `ring-client-api`. Tests replace
 * the factory; production constructs one `RingApi` per connection attempt.
 * @module @deepseek-ai/dsh-camera-ring/client
 */

import { RingApi } from 'ring-client-api'

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
