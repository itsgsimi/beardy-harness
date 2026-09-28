/**
 * signal-cli provider for the Signal capability: a local signal-cli HTTP daemon receives every
 * outbound message through a durable outbox and delivers inbound data messages over its event
 * stream. The provider logs whether the daemon answered at start and never stops the host when it
 * is unreachable; deliveries wait in the outbox until it answers.
 * @module @deepseek-ai/dsh-signal-cli
 */

import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-attachment'
import { formatSignalTarget, parseSignalNumber } from '@deepseek-ai/dsh-delivery-target'
import type { SignalNumber } from '@deepseek-ai/dsh-delivery-target'
import { SignalDeliveryId, SignalService } from '@deepseek-ai/dsh-signal'
import type { SignalDeliveryResult, SignalHealth, SignalSendRequest, SignalTarget } from '@deepseek-ai/dsh-signal'
import type {} from '@deepseek-ai/dsh-storage-domain'
import z from '@deepseek-ai/schemastery'
import { runReceiver } from './events.ts'
import { SignalOutbox, signalCliDomainSpec } from './outbox.ts'
import { accountsResponse, failureText, maskNumber, SignalCliRpc } from './rpc.ts'
import { splitText, styleText } from './text.ts'

export * from './events.ts'
export * from './outbox.ts'
export * from './rpc.ts'
export * from './text.ts'

/** Provider configuration. */
export interface Config {
  /** Daemon HTTP root, such as `http://127.0.0.1:8820`; only loopback hosts are accepted because the daemon has no authentication. */
  readonly baseUrl: string
  /** E.164 account sent with every request, for a multi-account daemon; leave unset for a daemon started with `-a`. */
  readonly account?: string
  /** Longest wait for one HTTP request in milliseconds; defaults to 15000. */
  readonly requestTimeoutMs?: number
  /** Subscribe to the daemon's event stream and publish inbound messages as `signal/message`; defaults to true. */
  readonly receive?: boolean
  /** First delay before reconnecting the event stream in milliseconds; defaults to 1000 and doubles. */
  readonly reconnectDelayMs?: number
  /** Ceiling on the doubled reconnect delay in milliseconds; defaults to 60000. */
  readonly maxReconnectDelayMs?: number
  /** Longest text of one Signal message in UTF-16 units; longer deliveries are split; defaults to 2000. */
  readonly maxMessageChars?: number
  /** Most unfinished deliveries before `send` refuses; defaults to 200. */
  readonly outboxMaxPending?: number
  /** Longest text of one delivery in UTF-16 units; defaults to 20000. */
  readonly outboxMaxChars?: number
  /** First delay after a failed send in milliseconds; defaults to 5000 and doubles. */
  readonly outboxRetryMs?: number
  /** Ceiling on the doubled send delay in milliseconds; defaults to 600000. */
  readonly outboxMaxRetryMs?: number
  /** Failed attempts after which a delivery is abandoned; defaults to 30. */
  readonly outboxMaxAttempts?: number
  /** Completed delivery ids kept to recognize a repeated id; defaults to 1000. */
  readonly outboxMaxReceipts?: number
}

/** Package defaults shared by the schema and {@link resolveSpec}. */
export const SIGNAL_CLI_DEFAULTS = Object.freeze({
  requestTimeoutMs: 15_000,
  receive: true,
  reconnectDelayMs: 1_000,
  maxReconnectDelayMs: 60_000,
  maxMessageChars: 2_000,
  outboxMaxPending: 200,
  outboxMaxChars: 20_000,
  outboxRetryMs: 5_000,
  outboxMaxRetryMs: 600_000,
  outboxMaxAttempts: 30,
  outboxMaxReceipts: 1_000,
})

/** Validated provider configuration. */
export const Config: z<Config> = z.object({
  baseUrl: z.string().required(),
  account: z.string(),
  requestTimeoutMs: z.number().step(1).min(100).max(300_000).default(SIGNAL_CLI_DEFAULTS.requestTimeoutMs),
  receive: z.boolean().default(SIGNAL_CLI_DEFAULTS.receive),
  reconnectDelayMs: z.number().step(1).min(10).max(3_600_000).default(SIGNAL_CLI_DEFAULTS.reconnectDelayMs),
  maxReconnectDelayMs: z.number().step(1).min(10).max(3_600_000).default(SIGNAL_CLI_DEFAULTS.maxReconnectDelayMs),
  maxMessageChars: z.number().step(1).min(100).max(10_000).default(SIGNAL_CLI_DEFAULTS.maxMessageChars),
  outboxMaxPending: z.number().step(1).min(1).max(100_000).default(SIGNAL_CLI_DEFAULTS.outboxMaxPending),
  outboxMaxChars: z.number().step(1).min(1).max(1_000_000).default(SIGNAL_CLI_DEFAULTS.outboxMaxChars),
  outboxRetryMs: z.number().step(1).min(10).max(3_600_000).default(SIGNAL_CLI_DEFAULTS.outboxRetryMs),
  outboxMaxRetryMs: z.number().step(1).min(10).max(86_400_000).default(SIGNAL_CLI_DEFAULTS.outboxMaxRetryMs),
  outboxMaxAttempts: z.number().step(1).min(1).max(1_000).default(SIGNAL_CLI_DEFAULTS.outboxMaxAttempts),
  outboxMaxReceipts: z.number().step(1).min(1).max(100_000).default(SIGNAL_CLI_DEFAULTS.outboxMaxReceipts),
})

/** Complete provider settings after defaults and validation. */
export interface SignalCliSpec {
  /** Normalized daemon root without a trailing slash, for messages. */
  readonly baseUrl: string
  /** JSON-RPC endpoint. */
  readonly rpcUrl: URL
  /** Server-Sent Events endpoint. */
  readonly eventsUrl: URL
  /** Liveness endpoint. */
  readonly checkUrl: URL
  readonly account?: SignalNumber
  readonly requestTimeoutMs: number
  readonly receive: boolean
  readonly reconnectDelayMs: number
  readonly maxReconnectDelayMs: number
  readonly maxMessageChars: number
  readonly outboxMaxPending: number
  readonly outboxMaxChars: number
  readonly outboxRetryMs: number
  readonly outboxMaxRetryMs: number
  readonly outboxMaxAttempts: number
  readonly outboxMaxReceipts: number
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Apply defaults and reject what the schema cannot: a daemon root that is not plain loopback HTTP,
 * a malformed account, and a reconnect or retry ceiling below its first delay.
 * @param config - schema-resolved configuration.
 * @returns complete provider settings.
 */
export function resolveSpec(config: Config): SignalCliSpec {
  let root: URL
  try {
    root = new URL(config.baseUrl)
  } catch {
    // URL parsing reports only TypeError; the configured value is the useful detail.
    throw new Error(`signal-cli: baseUrl "${config.baseUrl}" is not a URL`)
  }
  if (root.protocol !== 'http:' || !LOOPBACK_HOSTS.has(root.hostname) || root.username !== '' || root.password !== ''
    || root.pathname !== '/' || root.search !== '' || root.hash !== '') {
    throw new Error('signal-cli: baseUrl must be http://127.0.0.1:<port>, http://localhost:<port>, or http://[::1]:<port> '
      + 'with no path, because the daemon has no authentication')
  }
  let account: SignalNumber | undefined
  if (config.account !== undefined) {
    account = parseSignalNumber(config.account)
    if (account === undefined) throw new Error('signal-cli: account must be an E.164 number, such as +15551234567')
  }
  const spec: SignalCliSpec = {
    baseUrl: root.origin,
    rpcUrl: new URL('/api/v1/rpc', root),
    eventsUrl: new URL('/api/v1/events', root),
    checkUrl: new URL('/api/v1/check', root),
    ...account === undefined ? {} : { account },
    requestTimeoutMs: config.requestTimeoutMs ?? SIGNAL_CLI_DEFAULTS.requestTimeoutMs,
    receive: config.receive ?? SIGNAL_CLI_DEFAULTS.receive,
    reconnectDelayMs: config.reconnectDelayMs ?? SIGNAL_CLI_DEFAULTS.reconnectDelayMs,
    maxReconnectDelayMs: config.maxReconnectDelayMs ?? SIGNAL_CLI_DEFAULTS.maxReconnectDelayMs,
    maxMessageChars: config.maxMessageChars ?? SIGNAL_CLI_DEFAULTS.maxMessageChars,
    outboxMaxPending: config.outboxMaxPending ?? SIGNAL_CLI_DEFAULTS.outboxMaxPending,
    outboxMaxChars: config.outboxMaxChars ?? SIGNAL_CLI_DEFAULTS.outboxMaxChars,
    outboxRetryMs: config.outboxRetryMs ?? SIGNAL_CLI_DEFAULTS.outboxRetryMs,
    outboxMaxRetryMs: config.outboxMaxRetryMs ?? SIGNAL_CLI_DEFAULTS.outboxMaxRetryMs,
    outboxMaxAttempts: config.outboxMaxAttempts ?? SIGNAL_CLI_DEFAULTS.outboxMaxAttempts,
    outboxMaxReceipts: config.outboxMaxReceipts ?? SIGNAL_CLI_DEFAULTS.outboxMaxReceipts,
  }
  if (spec.maxReconnectDelayMs < spec.reconnectDelayMs) throw new Error('signal-cli: maxReconnectDelayMs must be at least reconnectDelayMs')
  if (spec.outboxMaxRetryMs < spec.outboxRetryMs) throw new Error('signal-cli: outboxMaxRetryMs must be at least outboxRetryMs')
  return spec
}

/** Replaceable network and clock seams. */
export interface SignalCliDeps {
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/**
 * Build the `send` parameters for one part.
 * @param target - destination.
 * @param part - part text with `**bold**` markers.
 * @param attachment - data URI of the image, for the first part.
 * @param account - account for a multi-account daemon.
 * @returns JSON-RPC `send` params.
 */
export function sendParams(target: SignalTarget, part: string, attachment: string | undefined,
  account: SignalNumber | undefined): Record<string, unknown> {
  const { message, textStyle } = styleText(part)
  return {
    ...account === undefined ? {} : { account },
    ...target.kind === 'group' ? { groupId: target.groupId } : { recipient: [target.number] },
    message,
    ...textStyle.length === 0 ? {} : { textStyle },
    ...attachment === undefined ? {} : { attachments: [attachment] },
  }
}

/** signal-cli daemon provider of `ctx.signal`. */
export class SignalCliService extends SignalService {
  static inject = ['storageDomain']
  static Config = Config
  private readonly spec: SignalCliSpec
  private readonly rpc: SignalCliRpc
  private readonly fetch: typeof globalThis.fetch
  private readonly now: () => number
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  private readonly controller = new AbortController()
  private outbox: SignalOutbox | undefined
  private account: SignalNumber | undefined

  /**
   * @param ctx - provider context with the storage domain.
   * @param config - schema-resolved configuration.
   * @param deps - replaceable fetch, clock, and delay.
   */
  constructor(ctx: Context, config: Config, deps: SignalCliDeps = {}) {
    super(ctx)
    this.spec = resolveSpec(config)
    this.fetch = deps.fetch ?? globalThis.fetch
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }) })
    this.rpc = new SignalCliRpc({
      rpcUrl: this.spec.rpcUrl, checkUrl: this.spec.checkUrl, timeoutMs: this.spec.requestTimeoutMs, fetch: this.fetch,
    })
    this.account = this.spec.account
  }

  /** Open the outbox, then announce the daemon, resume deliveries, and receive in the background. */
  async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(signalCliDomainSpec)
    const outbox = new SignalOutbox(domain.table('outbox'), {
      maxPending: this.spec.outboxMaxPending, retryMs: this.spec.outboxRetryMs, maxRetryMs: this.spec.outboxMaxRetryMs,
      maxAttempts: this.spec.outboxMaxAttempts, maxReceipts: this.spec.outboxMaxReceipts,
    }, (target, part, image) => this.sendPart(target, part, image), {
      warn: (line) => { this.ctx.logger.warn(line) },
      error: (line) => { this.ctx.logger.error(line) },
    }, this.now)
    this.outbox = outbox
    this.ctx.effect(() => {
      const signal = this.controller.signal
      const announcing = this.announce()
      outbox.start()
      const receiving = !this.spec.receive ? Promise.resolve() : runReceiver({
        eventsUrl: this.spec.eventsUrl, fetch: this.fetch, signal, sleep: this.sleep,
        reconnectDelayMs: this.spec.reconnectDelayMs, maxReconnectDelayMs: this.spec.maxReconnectDelayMs,
        publish: message => this.publishMessage(message),
        warn: (line) => { this.ctx.logger.warn(line) },
        debug: (line) => { this.ctx.logger.debug(line) },
      })
      return async () => {
        this.controller.abort(new Error('signal-cli disposed'))
        await outbox.dispose()
        await Promise.allSettled([announcing, receiving])
        await domain.close()
      }
    }, 'signal-cli daemon connection')
  }

  /**
   * Split, validate, and durably queue one message.
   * @param request - delivery id, destination, text, and optional image.
   * @returns the delivery id and whether it was newly queued.
   * @throws Error for empty or oversized text, or a full or stopping outbox.
   */
  async send(request: SignalSendRequest): Promise<SignalDeliveryResult> {
    if (request.text.length > this.spec.outboxMaxChars) {
      throw new Error(`Signal delivery text exceeds ${String(this.spec.outboxMaxChars)} characters`)
    }
    const parts = splitText(request.text, this.spec.maxMessageChars)
    if (parts.length === 0) throw new Error('Signal delivery has no visible text')
    const id = request.id ?? SignalDeliveryId(randomUUID())
    // The outbox opens in Service.init, which completes before the service is provided.
    const state = await (this.outbox as SignalOutbox).enqueue(id, formatSignalTarget(request.target), parts, request.image)
    return { id, state }
  }

  /**
   * Check the daemon now.
   * @returns reachability, the masked account when known, and pending deliveries.
   */
  async health(): Promise<SignalHealth> {
    const checkedAt = this.now()
    // The outbox opens in Service.init, which completes before the service is provided.
    const pending = (this.outbox as SignalOutbox).pending()
    const account = this.account === undefined ? {} : { account: maskNumber(this.account) }
    try {
      await this.rpc.check(this.controller.signal)
      return { reachable: true, ...account, checkedAt, pending }
    } catch (error: unknown) {
      return { reachable: false, ...account, checkedAt, pending, detail: failureText(error) }
    }
  }

  /** Log whether the daemon answered and which account it serves, masked. */
  private async announce(): Promise<void> {
    const signal = this.controller.signal
    try {
      await this.rpc.check(signal)
    } catch (error: unknown) {
      if (signal.aborted) return
      this.ctx.logger.error(`signal-cli: daemon at ${this.spec.baseUrl} is unreachable (${failureText(error)}); `
        + 'deliveries stay queued and retry until it answers')
      return
    }
    this.account = await this.reportedAccount(signal)
    if (signal.aborted) return
    this.ctx.logger.info(this.account === undefined
      ? `signal-cli: connected to ${this.spec.baseUrl}; the daemon did not report its account`
      : `signal-cli: connected as ${maskNumber(this.account)}`)
  }

  /**
   * Ask a multi-account daemon which accounts it serves. A daemon started with `-a` answers only
   * for its one account and may not offer `listAccounts`, so a failed call keeps the configured one.
   */
  private async reportedAccount(signal: AbortSignal): Promise<SignalNumber | undefined> {
    let numbers: SignalNumber[]
    try {
      const parsed = accountsResponse.safeParse(await this.rpc.call('listAccounts', {}, signal))
      if (!parsed.success) return this.spec.account
      numbers = parsed.data.flatMap(({ number }) => parseSignalNumber(number) ?? [])
    } catch {
      // A single-account daemon may reject the method; the check above already proved liveness.
      return this.spec.account
    }
    if (this.spec.account === undefined) return numbers.length === 1 ? numbers[0] : undefined
    if (!numbers.includes(this.spec.account)) {
      this.ctx.logger.error(`signal-cli: account ${maskNumber(this.spec.account)} is not registered with the daemon; sends will fail`)
    }
    return this.spec.account
  }

  private async sendPart(target: SignalTarget, part: string, image: ImageAttachmentRef | undefined): Promise<void> {
    const attachment = image === undefined ? undefined : await this.dataUri(image)
    await this.rpc.send(sendParams(target, part, attachment, this.spec.account), this.controller.signal)
  }

  /** Read a stored image as a data URI; an unreadable image leaves the text-only message. */
  private async dataUri(image: ImageAttachmentRef): Promise<string | undefined> {
    const store = this.ctx.get('attachments')
    if (store === undefined) {
      this.ctx.logger.warn('signal-cli: no attachment store is mounted; sending text only')
      return undefined
    }
    try {
      const { data } = await store.readImage(image, this.controller.signal)
      const extension = image.mediaType === 'image/jpeg' ? 'jpg' : image.mediaType.slice('image/'.length)
      const name = `${(image.name ?? 'image').replace(/\.[^.]*$/u, '').replace(/[;,\s]/gu, '_')}.${extension}`
      return `data:${image.mediaType};filename=${name};base64,${Buffer.from(data).toString('base64')}`
    } catch (error: unknown) {
      this.ctx.logger.warn(`signal-cli: stored image ${image.attachmentId} is unreadable; sending text only: ${failureText(error)}`)
      return undefined
    }
  }
}

export default SignalCliService
