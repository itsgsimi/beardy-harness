/**
 * Camera watch: classifies each camera event's frames in one logged model turn, applies the
 * notification policy, hands notices with a frame to the delivery owner through `camera/notice`,
 * keeps a bounded event history, and exposes it through the read-only `camera` tool.
 * @module @deepseek-ai/dsh-camera-watch
 */

import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-attachment'
import type { CameraDevice, CameraEvent, CameraVerdict } from '@deepseek-ai/dsh-camera'
import { boundContextSummary, errorChain } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { validateModelSelection } from '@deepseek-ai/dsh-unattended-session'
import { classifyFrames } from './classify.ts'
import { Config, resolveConfig } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { cameraWatchDomainSpec, frameAttachment, partitionHistory } from './history.ts'
import type { HistoryRecord } from './history.ts'
import { localDateTime, renderNotice } from './notice.ts'
import { lingeringMs, noticeReasons } from './policy.ts'
import { createCameraTool } from './tool.ts'
import type { CameraNotice, NoticeDelivery, VerdictStatus } from './types.ts'
import { classificationPrompt, parseVerdict } from './verdict.ts'

export * from './classify.ts'
export * from './config.ts'
export * from './history.ts'
export * from './notice.ts'
export * from './policy.ts'
export * from './tool.ts'
export * from './verdict.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One camera notice awaiting durable acceptance by its delivery owner.
     * @param notice - stable identity, destination channel, text, and optional frame.
     * @returns true after durable acceptance, or undefined when no listener owns delivery.
     * @mode serial
     */
    'camera/notice'(notice: CameraNotice): true | undefined | Promise<true | undefined>
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** One camera event's frames handed to a vision model for classification.
     * Readers preserve the message and attribution without the camera watch.
     * @persistenceAttribution
     */
    camera: {
      readonly kind: 'camera'
      /** Configured device that reported the event. */
      readonly deviceId: string
      /** Provider event id the classification belongs to. */
      readonly eventId: string
      readonly form: 'notice'
      readonly summary: string
    }
  }
}

/** Cordis plugin name. */
export const name = 'camera-watch'

/** The camera provider, model routes, Agent creation, image storage, durable history, and tool registry. */
export const inject = ['agentDefaultModel', 'agents', 'attachments', 'camera', 'llm', 'sessions', 'storageDomain', 'tools']

export { Config }

/** Clock and delay seams. */
export interface CameraWatchDeps {
  readonly now?: () => number
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/** One classification's usable result. */
interface Classification {
  readonly status: VerdictStatus
  readonly verdict?: CameraVerdict | undefined
  readonly text?: string | undefined
  readonly sessionId?: string | undefined
  readonly failure?: string | undefined
}

/** A selected route that declares no image input. */
class VisionRouteError extends Error {}

/** Counts from one retention sweep. */
interface SweepTally {
  events: number
  frames: number
  failedFrames: number
  firstFailure?: unknown
}

/** Queue, classification, policy, delivery, and history for accepted camera events. */
export class CameraWatch {
  private readonly queue: CameraEvent[] = []
  /** Accepted events whose handling has not finished, with the attachment ids of their frames. */
  private readonly inFlight = new Map<string, readonly string[]>()
  private readonly active = new Set<Promise<void>>()
  private readonly controller = new AbortController()
  private readonly devices: ReadonlyMap<string, CameraDevice>
  private readonly now: () => number
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  private running = 0
  private sweepTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * @param ctx - watch context with the injected services.
   * @param config - resolved watch settings.
   * @param table - durable history table.
   * @param deps - clock and delay seams.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
    private readonly table: KvTable<string, HistoryRecord>,
    deps: CameraWatchDeps = {},
  ) {
    this.devices = new Map(ctx.camera.devices().map(device => [String(device.id), device]))
    for (const id of config.policy.vehicleDevices) {
      if (!this.devices.has(id)) throw new Error(`camera-watch: policy.vehicleDevices names unknown camera device "${id}"`)
    }
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }) })
  }

  /** Run the first retention sweep now and each later one `sweepIntervalMs` after the previous one ends, until disposal. */
  start(): void {
    const sweep = (): void => {
      this.track(this.sweep().finally(() => {
        if (!this.controller.signal.aborted) this.sweepTimer = setTimeout(sweep, this.config.sweepIntervalMs)
      }))
    }
    sweep()
  }

  /**
   * Accept one provider event; a repeated event id is ignored. Beyond the queue bound the event is
   * recorded unclassified so a doorbell press still notifies.
   * @param event - provider event with stored frames.
   */
  accept(event: CameraEvent): void {
    if (this.controller.signal.aborted || this.inFlight.has(event.id) || this.table.get(event.id) !== undefined) return
    if (!this.devices.has(event.deviceId)) {
      this.ctx.logger.warn(`camera-watch: event ${event.id} names unknown device "${event.deviceId}"`)
      return
    }
    this.inFlight.set(event.id, event.frames.map(frame => String(frame.attachment.attachmentId)))
    if (this.running >= this.config.maxConcurrent && this.queue.length >= this.config.maxQueued) {
      this.track(this.finish(event, { status: 'skipped', failure: 'QUEUE_FULL' }))
      return
    }
    this.queue.push(event)
    this.pump()
  }

  /** Stop accepting events, cancel classifications and delivery waits, and wait for every write. */
  async dispose(): Promise<void> {
    this.controller.abort(new Error('camera-watch disposed'))
    clearTimeout(this.sweepTimer)
    this.queue.length = 0
    while (this.active.size > 0) await Promise.allSettled([...this.active])
  }

  /**
   * Delete expired records with the frames no kept record or unfinished event cites. A record stays
   * while any of its frames fails to delete, so the next sweep retries it; frames already gone count
   * as deleted.
   */
  private async sweep(): Promise<void> {
    const tally: SweepTally = { events: 0, frames: 0, failedFrames: 0 }
    try {
      const { expired, kept } = partitionHistory(this.table.entries(), this.now(), this.config.retentionMs, this.config.maxHistory)
      const cited = new Set(kept.flatMap(record => record.frames.map(frame => frame.attachmentId)))
      for (const [key, record] of expired) {
        if (this.controller.signal.aborted) break
        if (await this.deleteFrames(record, cited, tally)) {
          await this.table.delete(key)
          tally.events++
        }
      }
    } catch (error: unknown) {
      this.ctx.logger.warn(`camera-watch: history sweep failed: ${errorChain(error)}`)
    }
    if (tally.events > 0 || tally.frames > 0) {
      this.ctx.logger.info(`camera-watch: retention removed ${String(tally.events)} events and ${String(tally.frames)} frames`)
    }
    if (tally.failedFrames > 0) {
      this.ctx.logger.warn(`camera-watch: retention kept events with ${String(tally.failedFrames)} undeletable frames: ${errorChain(tally.firstFailure)}`)
    }
  }

  /**
   * Delete one expired record's frames that nothing retained cites.
   * @returns whether every such frame is now gone.
   */
  private async deleteFrames(record: HistoryRecord, cited: ReadonlySet<string>, tally: SweepTally): Promise<boolean> {
    let complete = true
    for (const frame of record.frames) {
      if (cited.has(frame.attachmentId) || [...this.inFlight.values()].some(ids => ids.includes(frame.attachmentId))) continue
      try {
        if (await this.ctx.attachments.deleteImage(frameAttachment(frame))) tally.frames++
      } catch (error: unknown) {
        complete = false
        tally.failedFrames++
        tally.firstFailure ??= error
      }
    }
    return complete
  }

  private track(operation: Promise<void>): void {
    const tracked = operation.catch((error: unknown) => {
      this.ctx.logger.warn(`camera-watch: event handling failed: ${errorChain(error)}`)
    }).finally(() => { this.active.delete(tracked) })
    this.active.add(tracked)
  }

  private pump(): void {
    while (this.running < this.config.maxConcurrent) {
      const event = this.queue.shift()
      if (event === undefined) return
      this.running++
      this.track(this.process(event).finally(() => {
        this.running--
        if (!this.controller.signal.aborted) this.pump()
      }))
    }
  }

  private async process(event: CameraEvent): Promise<void> {
    const classification = event.frames.length === 0
      ? { status: 'skipped' as const, failure: 'NO_FRAMES' }
      : await this.classify(event)
    await this.finish(event, classification)
  }

  private async selection(): Promise<ModelSelection> {
    const choice = this.config.modelSelection
    const selection = choice === undefined ? this.ctx.agentDefaultModel.currentSelection()
      : await validateModelSelection(this.ctx, choice, 'camera-watch: modelSelection')
    const info = await this.ctx.llm.resolveModelInfo(selection.provider, selection.model)
    if (info.inputModalities !== undefined && !info.inputModalities.includes('image')) {
      throw new VisionRouteError(`camera-watch: provider "${selection.provider}" model "${selection.model}" declares no image input`)
    }
    return selection
  }

  private async classify(event: CameraEvent): Promise<Classification> {
    let selection: ModelSelection
    try {
      selection = await this.selection()
    } catch (error: unknown) {
      this.ctx.logger.error(error instanceof VisionRouteError ? error.message : `camera-watch: model route unavailable: ${errorChain(error)}`)
      return { status: 'failed', failure: error instanceof VisionRouteError ? 'MODEL_NOT_VISION' : 'MODEL_UNAVAILABLE' }
    }
    const device = this.devices.get(event.deviceId) as CameraDevice
    const sessionId = SessionId(`camera-${event.deviceId}-${randomUUID()}`)
    const prompt = classificationPrompt({
      kind: event.kind,
      deviceLabel: device.label,
      localTime: localDateTime(event.occurredAt, this.config.timezone),
      offsetsMs: event.frames.map(frame => frame.offsetMs),
    })
    let outcome: Awaited<ReturnType<typeof classifyFrames>>
    try {
      outcome = await classifyFrames(this.ctx, {
        sessionId, prompt,
        frames: event.frames.map(frame => frame.attachment),
        source: {
          kind: 'camera', deviceId: event.deviceId, eventId: event.id, form: 'notice',
          summary: boundContextSummary(`${device.label} ${event.kind === 'ding' ? 'doorbell press' : 'motion'}`),
        },
        selection,
        maxOutputTokens: this.config.maxOutputTokens,
        timeoutMs: this.config.turnTimeoutMs,
        cwd: this.config.workspacePath,
        signal: this.controller.signal,
      })
    } catch (error: unknown) {
      this.ctx.logger.warn(`camera-watch: classification Session for ${event.id} could not start: ${errorChain(error)}`)
      return { status: 'failed', failure: 'SESSION_FAILED' }
    }
    if (outcome.kind === 'failed') return { status: 'failed', sessionId, failure: outcome.code }
    const reading = parseVerdict(outcome.text, event.frames.length)
    return { status: reading.status, verdict: reading.verdict, text: reading.text, sessionId }
  }

  private async finish(event: CameraEvent, classification: Classification): Promise<void> {
    const offsetsMs = event.frames.map(frame => frame.offsetMs)
    const policyEvent = { kind: event.kind, deviceId: event.deviceId, occurredAt: event.occurredAt, offsetsMs }
    const { verdict } = classification
    const reasons = noticeReasons(policyEvent, verdict, classification.status, this.config.policy, this.config.timezone)
    const channelId = this.config.deliverChannelId
    const record: HistoryRecord = {
      eventId: event.id,
      deviceId: event.deviceId,
      kind: event.kind,
      occurredAt: event.occurredAt,
      frames: event.frames.map(frame => ({ ...frame.attachment, offsetMs: Math.round(frame.offsetMs), source: frame.source })),
      ...event.captureFailure === undefined ? {} : { captureFailure: event.captureFailure },
      ...classification.sessionId === undefined ? {} : { sessionId: classification.sessionId },
      status: classification.status,
      ...classification.failure === undefined ? {} : { failure: classification.failure },
      ...verdict === undefined ? {} : { verdict: { ...verdict, labels: [...verdict.labels], personFrames: [...verdict.personFrames] } },
      ...classification.text === undefined ? {} : { text: classification.text },
      reasons,
      delivery: reasons.length === 0 ? 'none' : channelId === undefined ? 'no-channel' : 'undelivered',
    }
    try {
      await this.table.put(event.id, record)
      if (reasons.length === 0 || channelId === undefined) return
      const device = this.devices.get(event.deviceId) as CameraDevice
      const shown = event.frames[classification.verdict?.personFrames[0] ?? 0]
      const notice: CameraNotice = {
        id: `camera:${event.id}`,
        channelId,
        text: renderNotice({
          deviceLabel: device.label, occurredAt: event.occurredAt, timezone: this.config.timezone, reasons,
          status: classification.status, verdict: classification.verdict, text: classification.text,
          failure: classification.failure, captureFailure: event.captureFailure,
          lingerSeconds: classification.verdict === undefined ? 0 : Math.round(lingeringMs(policyEvent, classification.verdict) / 1_000),
        }),
        ...shown === undefined ? {} : { image: shown.attachment },
      }
      const delivery = await this.deliver(notice)
      if (delivery === 'delivered') await this.table.put(event.id, { ...record, delivery })
    } finally {
      this.inFlight.delete(event.id)
    }
  }

  private async deliver(notice: CameraNotice): Promise<NoticeDelivery> {
    for (let attempt = 1; ; attempt++) {
      try {
        if (await this.ctx.serial('camera/notice', notice) === true) return 'delivered'
        this.ctx.logger.warn(`camera-watch: no delivery owner accepted ${notice.id} (attempt ${String(attempt)})`)
      } catch (error: unknown) {
        this.ctx.logger.warn(`camera-watch: delivery of ${notice.id} failed (attempt ${String(attempt)}): ${errorChain(error)}`)
      }
      if (attempt >= this.config.deliveryAttempts || this.controller.signal.aborted) return 'undelivered'
      try {
        await this.sleep(this.config.deliveryRetryMs, this.controller.signal)
      } catch {
        // Only disposal aborts this delay; the notice stays recorded as undelivered.
        return 'undelivered'
      }
    }
  }
}

/**
 * Mount the watch on an opened history domain: validate device references, subscribe to
 * `camera/event`, register the tool, and own disposal.
 * @param ctx - watch context with the injected services.
 * @param config - schema-resolved configuration.
 * @param deps - clock and delay seams.
 */
export async function mountCameraWatch(ctx: Context, config: Config, deps: CameraWatchDeps = {}): Promise<void> {
  const resolved = resolveConfig(config)
  const domain = await ctx.storageDomain.open(cameraWatchDomainSpec)
  const table = domain.table('events')
  let watch: CameraWatch
  try {
    watch = new CameraWatch(ctx, resolved, table, deps)
  } catch (error: unknown) {
    await domain.close()
    throw error
  }
  ctx.on('camera/event', (event) => { watch.accept(event) })
  if (resolved.tool) {
    ctx.effect(() => ctx.tools.register(createCameraTool({
      table, devices: ctx.camera.devices(), timezone: resolved.timezone, maxEvents: resolved.toolMaxEvents,
      maxHours: Math.floor(resolved.retentionMs / 3_600_000), now: deps.now ?? Date.now,
    })), 'camera tool registration')
  }
  ctx.effect(() => {
    watch.start()
    return async () => {
      await watch.dispose()
      await domain.close()
    }
  }, 'camera watch')
}

/**
 * Mount the camera watch.
 * @param ctx - watch context with the injected services.
 * @param config - schema-resolved configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await mountCameraWatch(ctx, config)
}
