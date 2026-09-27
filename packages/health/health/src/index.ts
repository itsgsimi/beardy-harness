/**
 * Explicit HTTP endpoint probes and process-local health state. Transitions enter the Discord
 * gateway's durable outbox; this plugin never stores incidents or restarts a provider.
 * @module @deepseek-ai/dsh-health
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import type { CronRunFinished } from '@deepseek-ai/dsh-cron'
import z from '@deepseek-ai/schemastery'

/** Loader name of the Host health plugin. */
export const name = 'health'
/** Credential lookup is required only when a configured probe names a reference. */
export const inject = ['credentials']

/** One operator-selected endpoint; the URL is never inferred from a model provider. */
export interface ProbeConfig {
  /** Unique operator-facing label used in status and notices. */
  readonly name: string
  /** Explicit HTTP(S) target queried with GET. */
  readonly url: string
  /** Credential reference resolved as a bearer token for this request. */
  readonly credentialRef?: string
  /** Exact successful HTTP response status; defaults to 200. */
  readonly expectedStatus?: number
}

/** Health polling and notification bounds. */
export interface Config {
  /** Explicit targets; the empty default performs no network requests. */
  readonly probes?: ProbeConfig[]
  /** Delay after one complete poll before the next, in milliseconds. */
  readonly intervalMs?: number
  /** Deadline for each HTTP request, in milliseconds. */
  readonly timeoutMs?: number
  /** Consecutive failures required to mark an unknown or healthy probe down. */
  readonly failureThreshold?: number
  /** Consecutive successes required to mark a down probe healthy. */
  readonly recoveryThreshold?: number
  /** Discord channel that receives transition notices; absent means status only. */
  readonly noticeChannelId?: string
  /** Minimum time between accepted notices of the same kind for one probe, in milliseconds. */
  readonly noticeCooldownMs?: number
}

/** Validated, defaulted deployment configuration. */
export interface ResolvedConfig {
  readonly probes: ProbeConfig[]
  readonly intervalMs: number
  readonly timeoutMs: number
  readonly failureThreshold: number
  readonly recoveryThreshold: number
  readonly noticeChannelId?: string
  readonly noticeCooldownMs: number
}

/** Plugin configuration with no guessed endpoint or notification channel. */
export const Config: z<Config> = z.object({
  probes: z.array(z.object({
    name: z.string().required(),
    url: z.string().required(),
    credentialRef: z.string().role('credential-ref'),
    expectedStatus: z.number().min(100).max(599).default(200),
  })).default([]),
  intervalMs: z.number().min(1).default(60_000),
  timeoutMs: z.number().min(1).default(3_000),
  failureThreshold: z.number().min(1).default(3),
  recoveryThreshold: z.number().min(1).default(1),
  noticeChannelId: z.string(),
  noticeCooldownMs: z.number().min(0).default(900_000),
})

/** One probe's current process-local observation. */
export interface ProbeSnapshot {
  /** Configured probe label. */
  readonly name: string
  /** Current state since this Host mount. */
  readonly state: 'unknown' | 'healthy' | 'down'
  /** Epoch milliseconds of the latest completed HTTP check. */
  readonly checkedAt?: number
  /** Bounded status or failure class, absent after success. */
  readonly cause?: string
}

/** Most recent failed cron outcome observed by the gateway. */
export interface CronFailureSnapshot {
  /** Name of the failed scheduled job. */
  readonly jobName: string
  /** Reserved Session identity of that run. */
  readonly sessionId: string
  /** Failure code or terminal outcome when no classified failure exists. */
  readonly code: string
  /** Next armed UTC fire when the scheduler has one. */
  readonly nextFireAt?: string
}

/** Read-only status of process-local probes and the latest failed cron outcome. */
export interface HealthStatus {
  /**
   * Read bounded process-local status for human commands.
   * @returns current probe observations and the most recent failed cron fact, if any.
   */
  snapshot(): { probes: readonly ProbeSnapshot[]; lastCronFailure?: CronFailureSnapshot }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Process-local probe state for human status commands. */
    healthStatus: HealthStatus
  }
  interface Events {
    /**
     * One probe state transition awaiting durable Discord outbox acceptance.
     * @param transition - Stable identity, destination, and non-secret text.
     * @returns true after durable acceptance, or undefined when no gateway owns delivery.
     * @mode serial
     */
    'health/transition'(transition: { id: string; channelId: string; text: string }): true | undefined | Promise<true | undefined>
  }
}

/**
 * Reject duplicate names, non-HTTP URLs, credential-bearing URLs, and non-integral bounds.
 * @param config - defaulted deployment configuration to validate before polling.
 */
export function assertConfig(config: ResolvedConfig): void {
  for (const field of ['intervalMs', 'timeoutMs', 'failureThreshold', 'recoveryThreshold'] as const) {
    if (!Number.isSafeInteger(config[field]) || config[field] <= 0) throw new Error(`health: ${field} must be a positive safe integer`)
  }
  for (const field of ['intervalMs', 'timeoutMs'] as const) {
    if (config[field] > 2_147_483_647) throw new Error(`health: ${field} exceeds Node's timer range`)
  }
  if (!Number.isSafeInteger(config.noticeCooldownMs) || config.noticeCooldownMs < 0) {
    throw new Error('health: noticeCooldownMs must be a non-negative safe integer')
  }
  if (config.noticeChannelId !== undefined && !/^\d{17,20}$/.test(config.noticeChannelId)) {
    throw new Error('health: noticeChannelId must be a Discord snowflake of 17 to 20 digits')
  }
  const names = new Set<string>()
  for (const probe of config.probes) {
    if (probe.name.trim() === '' || names.has(probe.name)) throw new Error(`health: duplicate or empty probe name "${probe.name}"`)
    names.add(probe.name)
    let url: URL
    try { url = new URL(probe.url) } catch { throw new Error(`health: probe "${probe.name}" has an invalid URL`) }
    if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.hash !== '') {
      throw new Error(`health: probe "${probe.name}" needs an HTTP URL without embedded credentials or a fragment`)
    }
    if (probe.credentialRef !== undefined && !isCredentialRefName(probe.credentialRef)) {
      throw new Error(`health: probe "${probe.name}" credentialRef must name an environment-style credential`)
    }
    if (probe.expectedStatus !== undefined && (!Number.isSafeInteger(probe.expectedStatus)
      || probe.expectedStatus < 100 || probe.expectedStatus > 599)) {
      throw new Error(`health: probe "${probe.name}" expectedStatus must be an HTTP status`)
    }
  }
}

interface PendingNotice { readonly id: string; readonly channelId: string; readonly kind: 'down' | 'recovered'; readonly text: string }
interface ProbeRecord {
  state: ProbeSnapshot['state']
  failures: number
  successes: number
  checkedAt?: number
  cause: string | undefined
  generation: number
  pending: PendingNotice[]
  lastDownNotice?: number
  lastRecoveredNotice?: number
}

/** Replaceable external operations for a local HTTP fixture and gateway outbox tests. */
export interface HealthMonitorDeps {
  fetch: typeof fetch
  resolveCredential(reference: string): Promise<string | undefined>
  deliver(transition: { id: string; channelId: string; text: string }): Promise<boolean>
  deliveryFailed?(error: unknown): void
  now(): number
}

/** Process-local monitor that keeps polling while queued transitions retry in order. */
export class HealthMonitor implements HealthStatus {
  private readonly records: { probe: ProbeConfig; record: ProbeRecord }[]
  private readonly bootId = randomUUID()
  private readonly controller = new AbortController()
  private inFlight: Promise<void> | undefined
  private lastCronFailure: CronFailureSnapshot | undefined

  /** @param config - validated probe and threshold settings. @param deps - HTTP, credentials, clock, and outbox acceptance. */
  constructor(private readonly config: ResolvedConfig, private readonly deps: HealthMonitorDeps) {
    this.records = config.probes.map(probe => ({ probe, record: { state: 'unknown', failures: 0, successes: 0,
      cause: undefined, pending: [], generation: 0 } }))
  }

  /** Read one bounded snapshot without exposing URLs or credentials. */
  snapshot(): { probes: readonly ProbeSnapshot[]; lastCronFailure?: CronFailureSnapshot } {
    return { probes: this.records.map(({ probe, record }) => ({ name: probe.name, state: record.state,
      ...(record.checkedAt === undefined ? {} : { checkedAt: record.checkedAt }),
      ...(record.cause === undefined ? {} : { cause: record.cause }) })),
    ...(this.lastCronFailure === undefined ? {} : { lastCronFailure: this.lastCronFailure }) }
  }

  /**
   * Keep only the most recent failed run fact; the cron registry owns durable history.
   * @param run - settled cron outcome.
   */
  recordCronFailure(run: CronRunFinished): void {
    if (run.outcome !== 'failed' && run.outcome !== 'timed-out' && run.outcome !== 'interrupted') return
    const code = run.failure?.code
    this.lastCronFailure = { jobName: run.jobName, sessionId: run.sessionId,
      code: code !== undefined && /^[A-Z][A-Z0-9_-]{0,63}$/u.test(code) ? code : run.outcome.toUpperCase(),
      ...(run.nextFireAt === undefined ? {} : { nextFireAt: run.nextFireAt }) }
  }

  /** Poll every configured target once; simultaneous callers share the same poll. */
  check(): Promise<void> {
    if (this.controller.signal.aborted) return Promise.resolve()
    if (this.inFlight !== undefined) return this.inFlight
    const operation = (async () => {
      for (const { probe, record } of this.records) {
        if (this.controller.signal.aborted) break
        await this.checkProbe(probe, record)
      }
    })()
    this.inFlight = operation.finally(() => { this.inFlight = undefined })
    return this.inFlight
  }

  private async checkProbe(probe: ProbeConfig, record: ProbeRecord): Promise<void> {
    let healthy = false
    let cause = 'probe failed'
    try {
      const token = probe.credentialRef === undefined ? undefined : await this.deps.resolveCredential(probe.credentialRef)
      if (probe.credentialRef !== undefined && token === undefined) cause = 'credential unavailable'
      else {
        const response = await this.deps.fetch(probe.url, { method: 'GET',
          ...(token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } }),
          signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.config.timeoutMs)]),
        })
        healthy = response.status === (probe.expectedStatus ?? 200)
        if (!healthy) cause = `HTTP ${String(response.status)}`
        await response.body?.cancel()
      }
    } catch {
      cause = this.controller.signal.aborted ? 'stopped' : 'connection failed or timed out'
    }
    if (this.controller.signal.aborted) return
    const now = this.deps.now()
    record.checkedAt = now
    record.cause = healthy ? undefined : cause
    record.failures = healthy ? 0 : record.failures + 1
    record.successes = healthy ? record.successes + 1 : 0
    let next: 'down' | 'healthy' | undefined
    if (!healthy && record.state !== 'down' && record.failures >= this.config.failureThreshold) next = 'down'
    if (healthy && record.state !== 'healthy' && record.successes >= this.config.recoveryThreshold) next = 'healthy'
    if (next !== undefined) {
      const previous = record.state
      record.state = next
      record.generation++
      const kind = next === 'down' ? 'down' : 'recovered'
      const last = kind === 'down' ? record.lastDownNotice : record.lastRecoveredNotice
      if (!(previous === 'unknown' && next === 'healthy') && this.config.noticeChannelId !== undefined
        && (last === undefined || now - last >= this.config.noticeCooldownMs)) {
        record.pending.push({ id: `health:${this.bootId}:${probe.name}:${String(record.generation)}:${kind}`,
          channelId: this.config.noticeChannelId,
          kind, text: `Probe ${probe.name}: ${kind}${next === 'down' ? ` (${cause})` : ''}.` })
        if (kind === 'down') record.lastDownNotice = now
        else record.lastRecoveredNotice = now
      }
    }
    await this.flush(record)
  }

  private async flush(record: ProbeRecord): Promise<void> {
    let acceptedCount = 0
    for (const pending of record.pending) {
      let accepted: boolean
      try {
        accepted = await this.deps.deliver({ id: pending.id, channelId: pending.channelId, text: pending.text })
      } catch (error) {
        this.deps.deliveryFailed?.(error)
        break
      }
      if (!accepted) break
      if (pending.kind === 'down') record.lastDownNotice = this.deps.now()
      else record.lastRecoveredNotice = this.deps.now()
      acceptedCount++
    }
    record.pending.splice(0, acceptedCount)
  }

  /** Abort HTTP work and wait for any active poll before the Host fiber unmounts. */
  async dispose(): Promise<void> {
    this.controller.abort()
    await Promise.allSettled([this.inFlight])
  }
}

/** Mount probes, publish read-only status, and poll until the owning fiber disposes. */
export function apply(ctx: Context, raw: Config): void {
  const config = raw as ResolvedConfig
  assertConfig(config)
  const monitor = new HealthMonitor(config, {
    fetch: globalThis.fetch,
    resolveCredential: async reference => (await ctx.credentials.resolve(credentialRef(reference)))?.value,
    deliver: async transition => await ctx.serial('health/transition', transition) === true,
    deliveryFailed: (error) => { ctx.logger.warn(`health: probe notice could not enter the gateway outbox: ${error instanceof Error ? error.name : 'error'}`) },
    now: Date.now,
  })
  ctx.provide('healthStatus', monitor)
  ctx.on('cron/run-finished', (run) => { monitor.recordCronFailure(run) }, { prepend: true })
  ctx.effect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopping = false
    const poll = (): void => {
      void monitor.check().catch((error: unknown) => {
        ctx.logger.warn(`health: probe poll failed: ${error instanceof Error ? error.name : 'error'}`)
      }).finally(() => { if (!stopping) timer = setTimeout(poll, config.intervalMs) })
    }
    if (config.probes.length > 0) poll()
    return async () => {
      stopping = true
      if (timer !== undefined) clearTimeout(timer)
      await monitor.dispose()
    }
  }, 'health HTTP probes')
}
