/**
 * Ring provider for the camera capability: one account connection by refresh-token credential
 * reference with every rotation written back, push subscriptions for the configured devices,
 * per-device cooldown and duplicate suppression, and a bounded frame set per accepted event whose
 * first stored frame is previewed before the rest are captured.
 * @module @deepseek-ai/dsh-camera-ring
 */

import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-attachment'
import { CameraDeviceId, CameraEventId, CameraService } from '@deepseek-ai/dsh-camera'
import type { CameraDevice, CameraEventKind } from '@deepseek-ai/dsh-camera'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import { captureFrames, errorText } from './capture.ts'
import type { CaptureDeps, CaptureResult, CaptureSpec, FrameSink, SnapshotMiss, StreamFailure, StreamFailureStage } from './capture.ts'
import { createRingClient, RING_DING_CATEGORY, RING_MOTION_CATEGORY, ringLogging } from './client.ts'
import type { RingCameraHandle, RingClient, RingClientFactory, RingLogging, RingNotification, Unsubscribe } from './client.ts'

export * from './capture.ts'
export * from './client.ts'

/** One watched device, matched to the Ring account by exactly one of `ringId` or `ringName`. */
export interface DeviceConfig {
  /** Deployment device id used by consumers, such as `front-door`. */
  readonly id: string
  /** Label used in notices and prompts, such as `Front door`. */
  readonly label: string
  /** Ring's numeric device id. */
  readonly ringId?: number
  /** Device name shown in the Ring app, compared case-insensitively. */
  readonly ringName?: string
}

/** Ring provider configuration. */
export interface Config {
  /** Credential reference holding the Ring refresh token; the managed store must be able to write it. */
  readonly refreshTokenRef: string
  /** Devices to watch; every entry must match one device in the account. */
  readonly devices: DeviceConfig[]
  /** Event kinds to accept; defaults to motion and doorbell presses. */
  readonly events?: CameraEventKind[]
  /** Frames captured per event, from 1 through 6; defaults to 3. */
  readonly frameCount?: number
  /** Planned gap between frames in milliseconds; defaults to 10000. */
  readonly frameIntervalMs?: number
  /** Longest wait for one snapshot in milliseconds; defaults to 20000. */
  readonly snapshotTimeoutMs?: number
  /** Capture the remaining frames from a short live stream when a snapshot fails or repeats the previous one; defaults to true. */
  readonly streamFallback?: boolean
  /** Absolute ffmpeg executable; required when `streamFallback` is true. */
  readonly ffmpegPath?: string
  /** Longest wait for a live stream to start in milliseconds; defaults to 20000. */
  readonly streamSetupMs?: number
  /** Minimum gap between accepted motion events of one device in milliseconds; defaults to 120000. */
  readonly motionCooldownMs?: number
  /** Minimum gap between accepted doorbell presses of one device in milliseconds; defaults to 30000. */
  readonly dingCooldownMs?: number
  /** How long a vendor event id suppresses a repeated push, in milliseconds; defaults to 600000. */
  readonly dedupeWindowMs?: number
  /** Most remembered vendor event ids; defaults to 500. */
  readonly dedupeMaxIds?: number
  /** First delay after a failed connection in milliseconds; defaults to 5000 and doubles. */
  readonly reconnectDelayMs?: number
  /** Ceiling on the doubled reconnect delay in milliseconds; defaults to 600000. */
  readonly maxReconnectDelayMs?: number
  /** Name Ring lists for this client among authorized devices; defaults to `dsh-camera-ring`. */
  readonly controlCenterDisplayName?: string
  /**
   * Turn on `ring-client-api` debug lines, including ffmpeg stderr, and log them at `info`; noisy,
   * and on for the rest of the process once loaded. Defaults to false.
   */
  readonly vendorDebug?: boolean
}

/** Package defaults shared by the schema and {@link resolveSpec}. */
export const RING_DEFAULTS = Object.freeze({
  frameCount: 3,
  frameIntervalMs: 10_000,
  snapshotTimeoutMs: 20_000,
  streamFallback: true,
  streamSetupMs: 20_000,
  motionCooldownMs: 120_000,
  dingCooldownMs: 30_000,
  dedupeWindowMs: 600_000,
  dedupeMaxIds: 500,
  reconnectDelayMs: 5_000,
  maxReconnectDelayMs: 600_000,
  controlCenterDisplayName: 'dsh-camera-ring',
  vendorDebug: false,
})

/** Validated Ring provider configuration. */
export const Config: z<Config> = z.object({
  refreshTokenRef: z.string().role('credential-ref').required(),
  devices: z.array(z.object({
    id: z.string().required(),
    label: z.string().required(),
    ringId: z.number(),
    ringName: z.string(),
  })).required(),
  events: z.array(z.union(['motion', 'ding'])).default(['motion', 'ding']),
  frameCount: z.number().step(1).min(1).max(6).default(RING_DEFAULTS.frameCount),
  frameIntervalMs: z.number().step(1).min(1_000).max(60_000).default(RING_DEFAULTS.frameIntervalMs),
  snapshotTimeoutMs: z.number().step(1).min(1_000).max(60_000).default(RING_DEFAULTS.snapshotTimeoutMs),
  streamFallback: z.boolean().default(RING_DEFAULTS.streamFallback),
  ffmpegPath: z.string(),
  streamSetupMs: z.number().step(1).min(1_000).max(120_000).default(RING_DEFAULTS.streamSetupMs),
  motionCooldownMs: z.number().step(1).min(0).default(RING_DEFAULTS.motionCooldownMs),
  dingCooldownMs: z.number().step(1).min(0).default(RING_DEFAULTS.dingCooldownMs),
  dedupeWindowMs: z.number().step(1).min(1_000).default(RING_DEFAULTS.dedupeWindowMs),
  dedupeMaxIds: z.number().step(1).min(1).default(RING_DEFAULTS.dedupeMaxIds),
  reconnectDelayMs: z.number().step(1).min(1_000).default(RING_DEFAULTS.reconnectDelayMs),
  maxReconnectDelayMs: z.number().step(1).min(1_000).default(RING_DEFAULTS.maxReconnectDelayMs),
  controlCenterDisplayName: z.string().default(RING_DEFAULTS.controlCenterDisplayName),
  vendorDebug: z.boolean().default(RING_DEFAULTS.vendorDebug),
})

/** How one configured device is found in the Ring account. */
export type RingMatch =
  | { readonly kind: 'id'; readonly id: number }
  | { readonly kind: 'name'; readonly name: string }

/** One configured device with its validated id and Ring match. */
export interface ResolvedDevice extends CameraDevice {
  readonly match: RingMatch
}

/** Complete provider settings after defaults and cross-field validation. */
export interface RingSpec extends CaptureSpec {
  readonly refreshTokenRef: CredentialRef
  readonly devices: readonly ResolvedDevice[]
  readonly events: readonly CameraEventKind[]
  readonly ffmpegPath?: string
  readonly motionCooldownMs: number
  readonly dingCooldownMs: number
  readonly dedupeWindowMs: number
  readonly dedupeMaxIds: number
  readonly reconnectDelayMs: number
  readonly maxReconnectDelayMs: number
  readonly controlCenterDisplayName: string
  readonly vendorDebug: boolean
}

/**
 * Validate configuration that schema defaults cannot express: device identities, one Ring match per
 * device, unique ids, an absolute ffmpeg path for the stream fallback, and ordered reconnect bounds.
 * @param config - schema-resolved configuration.
 * @returns complete provider settings.
 */
export function resolveSpec(config: Config): RingSpec {
  if (!isCredentialRefName(config.refreshTokenRef)) {
    throw new Error('camera-ring: refreshTokenRef must name an environment-style credential reference')
  }
  if (config.devices.length === 0) throw new Error('camera-ring: devices must list at least one device')
  const ids = new Set<string>()
  const devices = config.devices.map((device): ResolvedDevice => {
    const id = CameraDeviceId(device.id)
    if (ids.has(id)) throw new Error(`camera-ring: device id "${id}" is configured twice`)
    ids.add(id)
    const label = device.label.trim()
    if (label === '' || label.length > 60) throw new Error(`camera-ring: device "${id}" needs a label of 1 to 60 characters`)
    const ringName = device.ringName?.trim() ?? ''
    if ((device.ringId === undefined) === (ringName === '')) {
      throw new Error(`camera-ring: device "${id}" must set exactly one of ringId or ringName`)
    }
    return { id, label, match: device.ringId === undefined ? { kind: 'name', name: ringName } : { kind: 'id', id: device.ringId } }
  })
  const events = [...new Set<CameraEventKind>(config.events ?? ['motion', 'ding'])]
  if (events.length === 0) throw new Error('camera-ring: events must list at least one event kind')
  const streamFallback = config.streamFallback ?? RING_DEFAULTS.streamFallback
  if (streamFallback && (config.ffmpegPath === undefined || !isAbsolute(config.ffmpegPath))) {
    throw new Error('camera-ring: ffmpegPath must be an absolute executable path when streamFallback is enabled')
  }
  const reconnectDelayMs = config.reconnectDelayMs ?? RING_DEFAULTS.reconnectDelayMs
  const maxReconnectDelayMs = config.maxReconnectDelayMs ?? RING_DEFAULTS.maxReconnectDelayMs
  if (reconnectDelayMs > maxReconnectDelayMs) throw new Error('camera-ring: reconnectDelayMs must not exceed maxReconnectDelayMs')
  return {
    refreshTokenRef: credentialRef(config.refreshTokenRef),
    devices,
    events,
    frameCount: config.frameCount ?? RING_DEFAULTS.frameCount,
    frameIntervalMs: config.frameIntervalMs ?? RING_DEFAULTS.frameIntervalMs,
    snapshotTimeoutMs: config.snapshotTimeoutMs ?? RING_DEFAULTS.snapshotTimeoutMs,
    streamFallback,
    ...streamFallback ? { ffmpegPath: config.ffmpegPath } : {},
    streamSetupMs: config.streamSetupMs ?? RING_DEFAULTS.streamSetupMs,
    motionCooldownMs: config.motionCooldownMs ?? RING_DEFAULTS.motionCooldownMs,
    dingCooldownMs: config.dingCooldownMs ?? RING_DEFAULTS.dingCooldownMs,
    dedupeWindowMs: config.dedupeWindowMs ?? RING_DEFAULTS.dedupeWindowMs,
    dedupeMaxIds: config.dedupeMaxIds ?? RING_DEFAULTS.dedupeMaxIds,
    reconnectDelayMs,
    maxReconnectDelayMs,
    controlCenterDisplayName: config.controlCenterDisplayName ?? RING_DEFAULTS.controlCenterDisplayName,
    vendorDebug: config.vendorDebug ?? RING_DEFAULTS.vendorDebug,
  }
}

/** Replaceable external operations. */
export interface RingProviderDeps extends Partial<CaptureDeps> {
  /** Ring connection factory; defaults to {@link createRingClient}. */
  readonly connect?: RingClientFactory
  /** Reject unless `path` is an executable regular file. */
  readonly checkExecutable?: (path: string) => Promise<void>
  /** Process-global `ring-client-api` logging; defaults to {@link ringLogging}. */
  readonly logging?: RingLogging
}

/** A configured device that the account does not contain; retrying cannot fix it. */
class RingDeviceMismatchError extends Error {}

/**
 * Reject unless `path` names an executable regular file.
 * @param path - absolute executable path.
 */
async function executable(path: string): Promise<void> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error('not a regular file')
  await access(path, constants.X_OK)
}

/**
 * Secret strings a refresh token exposes: the wrapped token and, when it decodes, its inner Ring
 * refresh token.
 * @param token - wrapped refresh token.
 * @returns strings to redact from diagnostics.
 */
export function tokenSecrets(token: string): string[] {
  const secrets = [token]
  try {
    const inner: unknown = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))
    if (typeof inner === 'object' && inner !== null && typeof (inner as { rt?: unknown }).rt === 'string') {
      secrets.push((inner as { rt: string }).rt)
    }
  } catch {
    // A token that is not base64 JSON exposes only itself.
  }
  return secrets.filter(secret => secret.length >= 8)
}

/**
 * Replace every secret occurrence and bound the diagnostic.
 * @param text - diagnostic text.
 * @param secrets - strings that must not appear.
 * @returns redacted text of at most 300 characters.
 */
export function redact(text: string, secrets: readonly string[]): string {
  let result = text
  for (const secret of secrets) result = result.split(secret).join('[redacted]')
  return result.length > 300 ? `${result.slice(0, 299)}…` : result
}

const SNAPSHOT_MISS_TEXT = { stale: 'repeated the previous snapshot', refused: 'was refused', timeout: 'timed out' } as const

/**
 * Describe the snapshot that ended the snapshot phase.
 * @param miss - the missing snapshot.
 * @param streamFallback - whether the remaining slots moved to a live stream.
 * @returns cause text after `snapshot <n> for <event id>`; `error` is not redacted here.
 */
export function describeSnapshotMiss(miss: SnapshotMiss, streamFallback: boolean): string {
  const cause = miss.error === undefined ? SNAPSHOT_MISS_TEXT[miss.reason] : `${SNAPSHOT_MISS_TEXT[miss.reason]}: ${miss.error}`
  return `${cause}; ${streamFallback ? `streaming the remaining ${String(miss.remaining)} frame(s)` : 'stream fallback is off'}`
}

const writtenText = (failure: StreamFailure): string => `${String(failure.framesWritten)} of ${String(failure.framesRequested)} frame(s) written`

/** Cause text per stream failure stage; the record type keeps the stage union exhaustive. */
const STREAM_FAILURE_TEXT: Readonly<Record<StreamFailureStage, (failure: StreamFailure) => string>> = {
  'start-refused': failure => String(failure.error),
  'start-timeout': failure => `no stream within ${String(failure.boundMs)} ms`,
  'ended-short': failure => `the call ended with ${writtenText(failure)}`,
  'run-timeout': failure => `stopped at the ${String(failure.boundMs)} ms bound with ${writtenText(failure)}`,
}

/**
 * Describe where a failed live-stream capture stopped.
 * @param failure - stream failure stage and counts.
 * @returns cause text after `failed at <stage>: `; `error` is not redacted here.
 */
export function describeStreamFailure(failure: StreamFailure): string {
  return STREAM_FAILURE_TEXT[failure.stage](failure)
}

/** Ring-backed `ctx.camera` provider. */
export class RingCameraService extends CameraService {
  static inject = ['credentials', 'attachments']
  static Config = Config
  private readonly spec: RingSpec
  private readonly connectClient: RingClientFactory
  private readonly checkExecutable: (path: string) => Promise<void>
  private readonly logging: RingLogging
  private readonly clock: CaptureDeps
  private readonly controller = new AbortController()
  private client: RingClient | undefined
  private subscriptions: Unsubscribe[] = []
  private readonly seen = new Map<string, number>()
  private readonly lastAccepted = new Map<string, number>()
  private readonly chains = new Map<string, Promise<void>>()
  private readonly pending = new Set<Promise<void>>()
  private tokenWrites: Promise<void> = Promise.resolve()
  private secrets: string[] = []

  /**
   * @param ctx - provider context with credentials and attachments.
   * @param config - schema-resolved configuration.
   * @param deps - replaceable Ring connection, executable check, clock, and delay.
   */
  constructor(ctx: Context, config: Config, deps: RingProviderDeps = {}) {
    super(ctx)
    this.spec = resolveSpec(config)
    this.connectClient = deps.connect ?? createRingClient
    this.checkExecutable = deps.checkExecutable ?? executable
    this.logging = deps.logging ?? ringLogging
    this.clock = {
      now: deps.now ?? Date.now,
      sleep: deps.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }) }),
    }
  }

  /**
   * List configured devices.
   * @returns devices in configuration order.
   */
  devices(): readonly CameraDevice[] {
    return this.spec.devices.map(device => ({ id: device.id, label: device.label }))
  }

  /** Fail loud on a missing or read-only token and a missing ffmpeg, then connect in the background. */
  async [Service.init](): Promise<void> {
    const ref = this.spec.refreshTokenRef
    const info = await this.ctx.credentials.describe(ref)
    if (!info.configured) {
      throw new Error(`camera-ring: credential ${ref} is not configured; store the refresh token from the one-time Ring login first`)
    }
    if (!info.writable) {
      throw new Error(`camera-ring: credential ${ref} comes from a read-only source (${info.source ?? 'unknown'}); `
        + 'store it in the managed credential store so every token rotation persists')
    }
    if (this.spec.ffmpegPath !== undefined) {
      try {
        await this.checkExecutable(this.spec.ffmpegPath)
      } catch {
        // The filesystem error adds nothing beyond the path the operator configured.
        throw new Error(`camera-ring: ffmpegPath ${this.spec.ffmpegPath} is not an executable file`)
      }
    }
    this.ctx.effect(() => this.logging.install({
      error: (message) => { this.ctx.logger.warn(`camera-ring: ring-client-api: ${this.redact(message)}`) },
      info: (message) => {
        const line = `camera-ring: ring-client-api: ${this.redact(message)}`
        if (this.spec.vendorDebug) this.ctx.logger.info(line)
        else this.ctx.logger.debug(line)
      },
    }), 'camera-ring vendor logger')
    if (this.spec.vendorDebug) this.logging.enableDebug()
    this.ctx.effect(() => {
      const running = this.run()
      return async () => {
        this.controller.abort(new Error('camera-ring disposed'))
        this.closeClient()
        await running
        while (this.pending.size > 0) await Promise.allSettled([...this.pending])
        await this.tokenWrites
      }
    }, 'camera-ring connection')
  }

  private get signal(): AbortSignal { return this.controller.signal }

  private redact(text: string): string { return redact(text, this.secrets) }

  /** Connect, retrying transient failures with a doubling delay; a device mismatch stops the provider. */
  private async run(): Promise<void> {
    let wait = this.spec.reconnectDelayMs
    for (;;) {
      try {
        await this.connect()
        return
      } catch (error: unknown) {
        this.closeClient()
        if (this.signal.aborted) return
        if (error instanceof RingDeviceMismatchError) {
          this.ctx.logger.error(error.message)
          return
        }
        this.ctx.logger.warn(`camera-ring: Ring connection failed; retrying in ${String(wait)} ms: ${this.redact(errorText(error))}`)
      }
      try {
        await this.clock.sleep(wait, this.signal)
      } catch {
        // Only disposal aborts this delay, and disposal ends the loop.
        return
      }
      wait = Math.min(wait * 2, this.spec.maxReconnectDelayMs)
    }
  }

  private async connect(): Promise<void> {
    const ref = this.spec.refreshTokenRef
    const resolved = await this.ctx.credentials.resolve(ref)
    if (resolved === undefined) throw new Error(`credential ${ref} is not configured`)
    this.secrets = [...new Set([...this.secrets, ...tokenSecrets(resolved.value)])]
    this.signal.throwIfAborted()
    const client = this.connectClient({
      refreshToken: resolved.value,
      controlCenterDisplayName: this.spec.controlCenterDisplayName,
      ffmpegPath: this.spec.ffmpegPath,
    })
    this.client = client
    this.subscriptions.push(client.onRefreshToken((token) => { this.persistToken(token) }))
    const cameras = await client.cameras()
    this.signal.throwIfAborted()
    const matched = this.spec.devices.map(device => ({ device, camera: cameras.find(camera => device.match.kind === 'id'
      ? camera.id === device.match.id
      : camera.name.trim().toLowerCase() === device.match.name.toLowerCase()) }))
    const missing = matched.filter(entry => entry.camera === undefined)
    if (missing.length > 0) {
      const wanted = missing.map(({ device }) => device.match.kind === 'id' ? String(device.match.id) : `"${device.match.name}"`)
      const available = cameras.map(camera => `"${camera.name}" (${String(camera.id)})`)
      throw new RingDeviceMismatchError(`camera-ring: no Ring device matches ${wanted.join(', ')}; `
        + `the account has ${available.length === 0 ? 'no cameras' : available.join(', ')}`)
    }
    for (const { device, camera } of matched) {
      const handle = camera as RingCameraHandle
      this.subscriptions.push(handle.onNotification((notification) => { this.admit(device, handle, notification) }))
    }
    this.ctx.logger.info(`camera-ring: watching ${String(matched.length)} Ring device(s)`)
  }

  private closeClient(): void {
    for (const unsubscribe of this.subscriptions) unsubscribe()
    this.subscriptions = []
    this.client?.disconnect()
    this.client = undefined
  }

  /** Write one rotated token through the credential reference, in rotation order. */
  private persistToken(token: string): void {
    this.secrets = [...new Set([...this.secrets, ...tokenSecrets(token)])]
    this.tokenWrites = this.tokenWrites.then(async () => {
      try {
        await this.ctx.credentials.set(this.spec.refreshTokenRef, token)
        this.ctx.logger.info(`camera-ring: stored the rotated Ring refresh token in ${this.spec.refreshTokenRef}`)
      } catch (error: unknown) {
        this.ctx.logger.warn(`camera-ring: the rotated Ring refresh token could not be stored: ${this.redact(errorText(error))}`)
      }
    })
  }

  /** Admit one push: known kind, not seen before, outside the device's cooldown, and not overlapping a motion capture. */
  private admit(device: ResolvedDevice, camera: RingCameraHandle, notification: RingNotification): void {
    const kind: CameraEventKind | undefined = notification.category === RING_DING_CATEGORY ? 'ding'
      : notification.category === RING_MOTION_CATEGORY ? 'motion' : undefined
    if (kind === undefined || !this.spec.events.includes(kind) || this.signal.aborted) return
    const now = this.clock.now()
    // Seen ids iterate oldest first: drop expired ids, and the oldest while the bound is full.
    for (const [key, at] of this.seen) {
      if (now - at < this.spec.dedupeWindowMs && this.seen.size < this.spec.dedupeMaxIds) break
      this.seen.delete(key)
    }
    const key = `${String(camera.id)}:${notification.dingId}`
    if (this.seen.has(key)) return
    this.seen.set(key, now)
    const cooldownKey = `${device.id}:${kind}`
    const last = this.lastAccepted.get(cooldownKey)
    if (last !== undefined && now - last < (kind === 'ding' ? this.spec.dingCooldownMs : this.spec.motionCooldownMs)) return
    if (kind === 'motion' && this.chains.has(device.id)) return
    this.lastAccepted.set(cooldownKey, now)
    const vendorId = notification.dingId.replace(/[^A-Za-z0-9._:-]/gu, '-').slice(0, 96)
    const id = CameraEventId(`ring-${String(camera.id)}-${vendorId === '' ? String(now) : vendorId}`)
    const previous = this.chains.get(device.id) ?? Promise.resolve()
    const run = previous.then(() => this.capture(device, camera, kind, id, now)).catch((error: unknown) => {
      if (!this.signal.aborted) this.ctx.logger.warn(`camera-ring: capture for ${id} failed: ${this.redact(errorText(error))}`)
    })
    const tracked: Promise<void> = run.finally(() => {
      if (this.chains.get(device.id) === tracked) this.chains.delete(device.id)
      this.pending.delete(tracked)
    })
    this.chains.set(device.id, tracked)
    this.pending.add(tracked)
  }

  private async capture(
    device: ResolvedDevice, camera: RingCameraHandle, kind: CameraEventKind, id: ReturnType<typeof CameraEventId>, t0: number,
  ): Promise<void> {
    const sink: FrameSink = {
      store: async (data, index) => {
        const refs = await this.ctx.attachments.saveImages([{ data, mediaType: 'image/jpeg', name: `${device.id}-${String(index + 1)}.jpg` }])
        return refs[0] as ImageAttachmentRef
      },
      first: frame => this.publishPreview({ id, deviceId: device.id, kind, occurredAt: t0, frame }),
    }
    const result = await captureFrames(camera, this.spec, t0, sink, this.signal, this.clock)
    this.signal.throwIfAborted()
    this.report(id, result)
    await this.publish({
      id, deviceId: device.id, kind, occurredAt: t0, frames: result.frames,
      ...result.failure === undefined ? {} : { captureFailure: result.failure },
    })
  }

  /** Log the snapshot that ended the snapshot phase at `info` and a failed live stream at `warn`. */
  private report(id: ReturnType<typeof CameraEventId>, result: CaptureResult): void {
    if (result.snapshotMiss !== undefined) {
      this.ctx.logger.info(`camera-ring: snapshot ${String(result.snapshotMiss.slot + 1)} for ${id} `
        + this.redact(describeSnapshotMiss(result.snapshotMiss, this.spec.streamFallback)))
    }
    if (result.streamFailure !== undefined) {
      this.ctx.logger.warn(`camera-ring: stream capture for ${id} failed at ${result.streamFailure.stage}: `
        + this.redact(describeStreamFailure(result.streamFailure)))
    }
  }
}

export default RingCameraService
