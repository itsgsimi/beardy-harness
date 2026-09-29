/**
 * Camera watch: classifies each camera event's frames in one logged model turn, applies the
 * notification policy, hands notices with a frame to the delivery owner through `camera/notice`
 * (a doorbell press, and a motion event whose first frame already notifies, first as soon as that
 * frame is stored), keeps a bounded event history, and exposes it through the read-only `camera` tool.
 * It resolves the model route when the route's provider registers and raises a rate-limited failure
 * notice when classification keeps failing.
 * @module @deepseek-ai/dsh-camera-watch
 */

import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-attachment'
import type { CameraDevice, CameraEvent, CameraPreview, CameraVerdict } from '@deepseek-ai/dsh-camera'
import { boundContextSummary, errorChain } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { validateModelSelection } from '@deepseek-ai/dsh-unattended-session'
import { classifyFrames } from './classify.ts'
import { Config, resolveConfig } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { ClassificationHealth, shortCause } from './health.ts'
import type { HealthNotice, RouteFailureCode } from './health.ts'
import { cameraWatchDomainSpec, frameAttachment, partitionHistory, vehicleBaseline } from './history.ts'
import type { HistoryRecord } from './history.ts'
import { localDateTime, RECOVERY_NOTICE_TEXT, renderDingNotice, renderFailureNotice, renderNotice } from './notice.ts'
import { addsToEarlyNotice, lingeringMs, noticeReasons, vehicleChange } from './policy.ts'
import type { EarlyStatement, VehicleChange } from './policy.ts'
import { createCameraTool } from './tool.ts'
import type { CameraNotice, NoticeReason, VerdictStatus } from './types.ts'
import { CLASSIFICATION_SYSTEM_PROMPT, classificationPrompt, parseVerdict } from './verdict.ts'

export * from './classify.ts'
export * from './config.ts'
export * from './health.ts'
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

/** The camera provider, model routes, Agent creation, prompt assembly, image storage, durable history, and tool registry. */
export const inject = ['agentDefaultModel', 'agents', 'attachments', 'camera', 'llm', 'sessions', 'storageDomain', 'systemPrompt', 'tools']

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

/** One failed route resolution, as logged and as a failure notice states it. */
interface RouteFailure {
  readonly code: RouteFailureCode
  /** Complete cause chain for the log. */
  readonly chain: string
  /** Bounded innermost cause for the notice. */
  readonly cause: string
}

function routeFailure(error: unknown): RouteFailure {
  return { code: error instanceof VisionRouteError ? 'MODEL_NOT_VISION' : 'MODEL_UNAVAILABLE', chain: errorChain(error), cause: shortCause(error) }
}

/** Handoff result of one notice after its attempts. */
type Handoff = 'delivered' | 'undelivered'

/** Settled outcome of an event's early notice. */
interface EarlyResult {
  /** Handoff of the early notice, when one was attempted. */
  readonly delivery?: Handoff | undefined
  /** First-frame classification Session of a motion event, when one was opened. */
  readonly sessionId?: string | undefined
  /** Reasons the first-frame classification found, when it answered. */
  readonly reasons?: readonly NoticeReason[] | undefined
  /** What an attempted early motion notice stated. */
  readonly statement?: EarlyStatement | undefined
}

/** An early notice awaiting its event: a doorbell notice, or a motion event's first-frame check. */
interface EarlyNotice {
  /** Attachment id of the frame the notice showed. */
  readonly frameId: string
  readonly result: Promise<EarlyResult>
}

/** A queued first-frame classification; `drop` settles its result unclassified when disposal discards it. */
interface EarlyJob {
  run(): Promise<void>
  drop(): void
}

/** Vehicle count movement of one event and the earlier event it was compared with. */
interface VehicleMovement {
  readonly change: VehicleChange
  readonly baselineEventId: string
}

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
  /** First-frame classifications waiting for a slot; they run before any queued event. */
  private readonly earlyQueue: EarlyJob[] = []
  /** Accepted events whose handling has not finished, with the attachment ids of their frames. */
  private readonly inFlight = new Map<string, readonly string[]>()
  /** Immediate doorbell notices by event id, until their event is recorded. */
  private readonly early = new Map<string, EarlyNotice>()
  private readonly active = new Set<Promise<void>>()
  private readonly controller = new AbortController()
  private readonly devices: ReadonlyMap<string, CameraDevice>
  private readonly now: () => number
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  private readonly health: ClassificationHealth
  private running = 0
  private sweepTimer: ReturnType<typeof setTimeout> | undefined
  /** Whether the route's provider was registered at the latest check. */
  private routeRegistered = false

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
    for (const field of ['personDevices', 'vehicleDevices'] as const) {
      for (const id of config.policy[field]) {
        if (!this.devices.has(id)) throw new Error(`camera-watch: policy.${field} names unknown camera device "${id}"`)
      }
    }
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }) })
    this.health = new ClassificationHealth({ threshold: config.failureNoticeThreshold, intervalMs: config.failureNoticeIntervalMs })
  }

  /**
   * Run the first retention sweep now and each later one `sweepIntervalMs` after the previous one
   * ends, until disposal, and check the model route if its provider is already registered.
   */
  start(): void {
    const sweep = (): void => {
      this.track(this.sweep().finally(() => {
        if (!this.controller.signal.aborted) this.sweepTimer = setTimeout(sweep, this.config.sweepIntervalMs)
      }))
    }
    sweep()
    this.checkRoute()
  }

  /**
   * Resolve the classification route, with the image-input check, when its provider has become
   * registered since the previous call: `modelSelection` or, without it, the host default model's
   * provider at this call. Logs the route on success; a failure is logged and raises the failure
   * notice. Never throws, so a broken route leaves the host running.
   */
  checkRoute(): void {
    const { provider } = this.config.modelSelection ?? this.ctx.agentDefaultModel.currentSelection()
    const registered = this.ctx.llm.listProviders().some(info => info.id === provider)
    const appeared = registered && !this.routeRegistered
    this.routeRegistered = registered
    if (appeared) this.track(this.resolveRoute())
  }

  private async resolveRoute(): Promise<void> {
    try {
      const { provider, model } = await this.selection()
      this.ctx.logger.info(`camera-watch: classifying with ${provider}/${model}`)
    } catch (error: unknown) {
      const failure = routeFailure(error)
      this.ctx.logger.error(`camera-watch: model route check failed: ${failure.chain}`)
      this.report(this.health.routeFailed(failure.code, failure.cause, this.now()))
    }
  }

  /**
   * Log a failure or recovery notice and, with a channel, hand it to `camera/notice` without
   * waiting for the handoff. Nothing is reported after disposal starts.
   */
  private report(notice: HealthNotice | undefined): void {
    if (notice === undefined || this.controller.signal.aborted) return
    let text: string
    if (notice.kind === 'failing') {
      this.ctx.logger.warn(`camera-watch: classification is failing (${notice.code}: ${notice.cause})`)
      text = renderFailureNotice({ code: notice.code, cause: notice.cause, dingNotifies: this.config.policy.ding })
    } else {
      this.ctx.logger.info('camera-watch: classification recovered')
      text = RECOVERY_NOTICE_TEXT
    }
    const channelId = this.config.deliverChannelId
    if (channelId === undefined) return
    this.track(this.deliver({ id: notice.id, channelId, text }).then(() => undefined))
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

  /**
   * Start the early notice for a new event whose first frame is stored, while a channel is
   * configured. A doorbell press posts its notice at once (`immediateDingNotice` and `policy.ding`).
   * A motion event queues a classification of that frame alone ahead of every queued event
   * (`earlyMotionNotice`), unless no slot is free and the event queue is full, and posts a notice when
   * the frame already notifies. The event's classified notice waits for this early notice to settle.
   * @param preview - accepted event's identity and first frame.
   */
  preview(preview: CameraPreview): void {
    const channelId = this.config.deliverChannelId
    if (channelId === undefined || this.controller.signal.aborted || this.early.has(preview.id) || this.inFlight.has(preview.id)
      || this.table.get(preview.id) !== undefined) return
    const device = this.devices.get(preview.deviceId)
    if (device === undefined) return
    const frameId = String(preview.frame.attachment.attachmentId)
    if (preview.kind === 'ding') {
      if (!this.config.immediateDingNotice || !this.config.policy.ding) return
      const delivery = this.deliver({
        id: `camera:${preview.id}:ding`,
        channelId,
        text: renderDingNotice({ deviceLabel: device.label, occurredAt: preview.occurredAt, timezone: this.config.timezone }),
        image: preview.frame.attachment,
      })
      this.early.set(preview.id, { frameId, result: delivery.then(handoff => ({ delivery: handoff })) })
      this.track(delivery.then(() => undefined))
      return
    }
    if (!this.config.earlyMotionNotice
      || (this.running >= this.config.maxConcurrent && this.queue.length >= this.config.maxQueued)) return
    const { promise: result, resolve: settle } = Promise.withResolvers<EarlyResult>()
    this.early.set(preview.id, { frameId, result })
    this.earlyQueue.push({
      run: async () => {
        try {
          settle(await this.earlyMotion(preview, channelId, device))
        } finally {
          // A settled result ignores this; after a failure the event goes on without an early notice.
          settle({})
        }
      },
      drop: () => { settle({}) },
    })
    this.pump()
  }

  /**
   * Classify a motion event's first frame and post the early notice when it yields a reason.
   * @returns the check's Session, reasons, and notice outcome.
   */
  private async earlyMotion(preview: CameraPreview, channelId: string, device: CameraDevice): Promise<EarlyResult> {
    const { frame, ...identity } = preview
    const event: CameraEvent = { ...identity, frames: [frame] }
    const classification = await this.classify(event, true)
    const session = { sessionId: classification.sessionId }
    if (classification.status === 'failed') return session
    const { verdict } = classification
    const policyEvent = { kind: event.kind, deviceId: event.deviceId, occurredAt: event.occurredAt, offsetsMs: [frame.offsetMs] }
    const reasons = noticeReasons(policyEvent, verdict, classification.status, this.config.policy, this.config.timezone)
    if (reasons.length === 0 || verdict === undefined) return { ...session, reasons }
    const delivery = await this.deliver({
      id: `camera:${event.id}:early`,
      channelId,
      text: renderNotice({
        deviceLabel: device.label, occurredAt: event.occurredAt, timezone: this.config.timezone, reasons,
        status: classification.status, verdict, lingerSeconds: 0, stage: 'first-frame',
      }),
      image: frame.attachment,
    })
    return { ...session, reasons, statement: { reasons, verdict }, delivery }
  }

  /** Stop accepting events, cancel classifications and delivery waits, and wait for every write. */
  async dispose(): Promise<void> {
    this.controller.abort(new Error('camera-watch disposed'))
    clearTimeout(this.sweepTimer)
    this.queue.length = 0
    for (const job of this.earlyQueue.splice(0)) job.drop()
    while (this.active.size > 0) await Promise.allSettled([...this.active])
    this.early.clear()
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
      if (cited.has(frame.attachmentId) || [...this.inFlight.values()].some(ids => ids.includes(frame.attachmentId))
        || [...this.early.values()].some(early => early.frameId === frame.attachmentId)) continue
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

  /**
   * Start queued work while slots are free, first-frame classifications first. An event's own
   * first-frame job therefore always starts before the event, so an event holding a slot while it
   * waits for its early notice never waits on a job that needs a slot.
   */
  private pump(): void {
    while (this.running < this.config.maxConcurrent) {
      let work: Promise<void>
      const job = this.earlyQueue.shift()
      if (job === undefined) {
        const event = this.queue.shift()
        if (event === undefined) return
        work = this.process(event)
      } else work = job.run()
      this.running++
      this.track(work.finally(() => {
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
      throw new VisionRouteError(`provider "${selection.provider}" model "${selection.model}" declares no image input`)
    }
    return selection
  }

  /**
   * Run one logged classification of the event's frames, or of its first frame alone.
   * @returns the reading, or a failure code.
   */
  private async classify(event: CameraEvent, firstFrame = false): Promise<Classification> {
    let selection: ModelSelection
    try {
      selection = await this.selection()
    } catch (error: unknown) {
      const failure = routeFailure(error)
      this.ctx.logger.error(failure.code === 'MODEL_NOT_VISION' ? `camera-watch: ${failure.chain}` : `camera-watch: model route unavailable: ${failure.chain}`)
      this.report(this.health.routeFailed(failure.code, failure.cause, this.now()))
      return { status: 'failed', failure: failure.code }
    }
    const device = this.devices.get(event.deviceId) as CameraDevice
    const sessionId = SessionId(`camera-${event.deviceId}-${randomUUID()}`)
    const prompt = classificationPrompt({
      kind: event.kind,
      deviceLabel: device.label,
      localTime: localDateTime(event.occurredAt, this.config.timezone),
      offsetsMs: event.frames.map(frame => frame.offsetMs),
      firstFrame,
    })
    let outcome: Awaited<ReturnType<typeof classifyFrames>>
    try {
      outcome = await classifyFrames(this.ctx, {
        sessionId, systemPrompt: CLASSIFICATION_SYSTEM_PROMPT, prompt,
        frames: event.frames.map(frame => frame.attachment),
        source: {
          kind: 'camera', deviceId: event.deviceId, eventId: event.id, form: 'notice',
          summary: boundContextSummary(`${device.label} ${event.kind === 'ding' ? 'doorbell press' : 'motion'}${firstFrame ? ' (first frame)' : ''}`),
        },
        selection,
        maxOutputTokens: this.config.maxOutputTokens,
        timeoutMs: this.config.turnTimeoutMs,
        cwd: this.config.workspacePath,
        signal: this.controller.signal,
      })
    } catch (error: unknown) {
      this.ctx.logger.warn(`camera-watch: classification Session for ${event.id} could not start: ${errorChain(error)}`)
      this.report(this.health.turnFailed('SESSION_FAILED', this.now()))
      return { status: 'failed', failure: 'SESSION_FAILED' }
    }
    if (outcome.kind === 'failed') {
      this.report(this.health.turnFailed(outcome.code, this.now()))
      return { status: 'failed', sessionId, failure: outcome.code }
    }
    this.report(this.health.answered())
    const reading = parseVerdict(outcome.text, event.frames.length)
    return { status: reading.status, verdict: reading.verdict, text: reading.text, sessionId }
  }

  /**
   * Compare a `vehicleDevices` event's vehicle count with the device's latest earlier event inside
   * `policy.arrivalBaselineMs`; both verdicts must reach `policy.minConfidence`.
   * @returns the movement, or undefined without a baseline or when the counts are equal.
   */
  private vehicleMovement(event: CameraEvent, verdict: CameraVerdict | undefined): VehicleMovement | undefined {
    const { policy } = this.config
    if (verdict === undefined || policy.arrivalBaselineMs === 0 || !policy.vehicleDevices.includes(event.deviceId)
      || verdict.confidence < policy.minConfidence) return undefined
    const baseline = vehicleBaseline(this.table.entries(), event.deviceId, event.occurredAt, policy.arrivalBaselineMs, policy.minConfidence)
    const change = baseline === undefined ? undefined : vehicleChange(verdict, baseline.verdict)
    return change === undefined || baseline === undefined ? undefined : { change, baselineEventId: baseline.eventId }
  }

  private async finish(event: CameraEvent, classification: Classification): Promise<void> {
    const offsetsMs = event.frames.map(frame => frame.offsetMs)
    const policyEvent = { kind: event.kind, deviceId: event.deviceId, occurredAt: event.occurredAt, offsetsMs }
    const { verdict } = classification
    const movement = this.vehicleMovement(event, verdict)
    const reasons = noticeReasons(policyEvent, verdict, classification.status, this.config.policy, this.config.timezone, movement?.change)
    const channelId = this.config.deliverChannelId
    const early = this.early.get(event.id)
    try {
      let earlyResult: EarlyResult = {}
      let postedFrameId: string | undefined
      if (early !== undefined) {
        earlyResult = await early.result
        if (earlyResult.delivery === 'delivered') postedFrameId = early.frameId
      }
      // A delivered early motion notice makes the classified notice an update, posted only when it adds to it.
      const statement = earlyResult.delivery === 'delivered' ? earlyResult.statement : undefined
      const posts = reasons.length > 0 && (statement === undefined || addsToEarlyNotice(statement, reasons, verdict))
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
        delivery: !posts ? 'none' : channelId === undefined ? 'no-channel' : 'undelivered',
        ...earlyResult.delivery === undefined ? {} : { earlyDelivery: earlyResult.delivery },
        ...earlyResult.sessionId === undefined ? {} : { earlySessionId: earlyResult.sessionId },
        ...earlyResult.reasons === undefined ? {} : { earlyReasons: [...earlyResult.reasons] },
        ...movement === undefined ? {} : { vehicleChange: movement.change, baselineEventId: movement.baselineEventId },
      }
      await this.table.put(event.id, record)
      if (!posts || channelId === undefined) return
      const device = this.devices.get(event.deviceId) as CameraDevice
      const shown = event.frames[verdict?.personFrames[0] ?? 0]
      // A frame the delivered early notice already showed is not attached again.
      const image = shown === undefined || String(shown.attachment.attachmentId) === postedFrameId ? undefined : shown.attachment
      const notice: CameraNotice = {
        id: `camera:${event.id}`,
        channelId,
        text: renderNotice({
          deviceLabel: device.label, occurredAt: event.occurredAt, timezone: this.config.timezone, reasons,
          status: classification.status, verdict, text: classification.text,
          failure: classification.failure, captureFailure: event.captureFailure,
          lingerSeconds: verdict === undefined ? 0 : Math.round(lingeringMs(policyEvent, verdict) / 1_000),
          vehicleChange: movement?.change,
          stage: statement === undefined ? undefined : 'update',
        }),
        ...image === undefined ? {} : { image },
      }
      const delivery = await this.deliver(notice)
      if (delivery === 'delivered') await this.table.put(event.id, { ...record, delivery })
    } finally {
      this.inFlight.delete(event.id)
      this.early.delete(event.id)
    }
  }

  private async deliver(notice: CameraNotice): Promise<Handoff> {
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
 * `camera/event`, check the model route at start and on each `llm/adapters-updated`, register the
 * tool, and own disposal.
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
  ctx.on('camera/preview', (preview) => { watch.preview(preview) })
  ctx.on('camera/event', (event) => { watch.accept(event) })
  ctx.on('llm/adapters-updated', () => { watch.checkRoute() })
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
