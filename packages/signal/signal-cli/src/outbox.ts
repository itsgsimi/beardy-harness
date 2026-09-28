/**
 * Durable Signal outbox: each accepted delivery is persisted with its parts before any send, sent
 * in acceptance order per target with a part checkpoint, retried with a doubling delay, abandoned
 * after its attempt limit or a permanent failure, and remembered as a bounded receipt so a repeated
 * id is recognized.
 * @module @deepseek-ai/dsh-signal-cli/outbox
 */

import { z } from 'zod'
import { AttachmentId, imageAttachmentRefSchema } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { signalTargetOf } from '@deepseek-ai/dsh-delivery-target'
import type { SignalTarget } from '@deepseek-ai/dsh-signal'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { failureText, isPermanent } from './rpc.ts'

/** One delivery's durable state; a completed record keeps only its receipt fields. */
export const outboxRecord = z.object({
  /** `signal:group:<id>` or `signal:number:<number>`. */
  target: z.string().refine(value => signalTargetOf(value) !== undefined, 'not a Signal target'),
  /** Remaining text parts in order; emptied on completion. */
  parts: z.array(z.string().min(1)),
  /** Stored image sent with the first part. */
  image: imageAttachmentRefSchema.optional(),
  /** Acceptance order, independent of backend iteration order and clock movement. */
  ordinal: z.number().int().positive(),
  createdAt: z.number(),
  /** Parts already acknowledged by the daemon. */
  cursor: z.number().int().nonnegative(),
  /** Failed attempts so far. */
  attempts: z.number().int().nonnegative(),
  /** Earliest epoch milliseconds of the next send attempt. */
  nextAttemptAt: z.number(),
  /** Epoch milliseconds when the delivery finished or was abandoned. */
  completedAt: z.number().optional(),
  /** Why the delivery was abandoned; absent when it was sent. */
  abandoned: z.string().max(500).optional(),
}).refine(record => record.cursor <= record.parts.length)

/** Validated delivery state. */
export type OutboxRecord = z.infer<typeof outboxRecord>

/** The provider's durable unit; opening requires the declared version. */
export const signalCliDomainSpec = defineDomain({
  name: 'signal_cli',
  version: 1,
  tables: {
    outbox: domainTable<string, OutboxRecord>(outboxRecord),
  },
})

/**
 * Rebuild the typed reference from a persisted image record.
 * @param image - validated persisted image, if any.
 * @returns the attachment reference, or undefined.
 */
export function storedImage(image: OutboxRecord['image']): ImageAttachmentRef | undefined {
  if (image === undefined) return undefined
  const { attachmentId, name, originalDimensions, ...encoded } = image
  return {
    ...encoded, attachmentId: AttachmentId(attachmentId),
    ...name === undefined ? {} : { name }, ...originalDimensions === undefined ? {} : { originalDimensions },
  }
}

/** Queue bounds and retry policy. */
export interface OutboxSettings {
  readonly maxPending: number
  readonly retryMs: number
  readonly maxRetryMs: number
  readonly maxAttempts: number
  readonly maxReceipts: number
}

/** Sends one part; the image accompanies the first part only. Resolves after the daemon acknowledged it. */
export type PartSender = (target: SignalTarget, part: string, image: ImageAttachmentRef | undefined) => Promise<void>

/** Outbox logging. */
export interface OutboxLog {
  readonly warn: (line: string) => void
  readonly error: (line: string) => void
}

/** Persistent queue owner; `enqueue` promises durability, never delivery. */
export class SignalOutbox {
  private timer: ReturnType<typeof setTimeout> | undefined
  private writes: Promise<unknown> = Promise.resolve()
  private draining: Promise<void> | undefined
  private stopping = false
  private retryAt = 0

  /**
   * @param table - durable records keyed by delivery id.
   * @param settings - bounds and retry policy.
   * @param sendPart - transmits one part.
   * @param log - failure reporting.
   * @param now - clock for scheduling.
   */
  constructor(
    private readonly table: KvTable<string, OutboxRecord>,
    private readonly settings: OutboxSettings,
    private readonly sendPart: PartSender,
    private readonly log: OutboxLog,
    private readonly now: () => number = Date.now,
  ) {}

  /** Resume persisted deliveries. */
  start(): void { this.arm() }

  /**
   * Persist one delivery unless its id was already accepted.
   * @param id - delivery identity.
   * @param target - Signal destination as a target string.
   * @param parts - non-empty ordered parts.
   * @param image - stored image for the first part.
   * @returns `queued`, or `duplicate` when the id is pending or still has a receipt.
   * @throws Error when the outbox is stopping or full.
   */
  async enqueue(id: string, target: string, parts: readonly string[], image: ImageAttachmentRef | undefined): Promise<'queued' | 'duplicate'> {
    const write = this.writes.then(async (): Promise<'queued' | 'duplicate'> => {
      if (this.stopping) throw new Error('Signal outbox is stopping')
      if (this.table.get(id) !== undefined) return 'duplicate'
      if (this.pending() >= this.settings.maxPending) throw new Error('Signal outbox is full; the delivery was not queued')
      const ordinal = [...this.table.entries()].reduce((maximum, [, record]) => Math.max(maximum, record.ordinal), 0) + 1
      const now = this.now()
      await this.table.put(id, {
        target, parts: [...parts], ...image === undefined ? {} : { image },
        cursor: 0, ordinal, createdAt: now, nextAttemptAt: now, attempts: 0,
      })
      return 'queued'
    })
    this.writes = write.catch(() => undefined)
    const state = await write
    if (state === 'queued') this.arm()
    return state
  }

  /**
   * Count deliveries not yet sent or abandoned.
   * @returns the count.
   */
  pending(): number {
    return this.unfinished().length
  }

  /** Stop scheduling and wait for the write and send in progress. */
  async dispose(): Promise<void> {
    this.stopping = true
    clearTimeout(this.timer)
    await this.writes
    await this.draining
  }

  private unfinished(): [string, OutboxRecord][] {
    return [...this.table.entries()].filter(([, record]) => record.completedAt === undefined)
  }

  private arm(): void {
    if (this.stopping || this.draining !== undefined) return
    clearTimeout(this.timer)
    const due = this.unfinished().map(([, record]) => record.nextAttemptAt)
    if (due.length === 0) return
    this.timer = setTimeout(() => {
      this.draining = this.drain().catch((error: unknown) => {
        this.retryAt = this.now() + this.settings.retryMs
        this.log.warn(`signal-cli: outbox persistence failed: ${failureText(error)}`)
      }).finally(() => {
        this.draining = undefined
        this.arm()
      })
    }, Math.min(2_147_483_647, Math.max(0, this.retryAt - this.now(), Math.min(...due) - this.now())))
  }

  private async drain(): Promise<void> {
    const blocked = new Set<string>()
    const pending = this.unfinished().sort((left, right) => left[1].ordinal - right[1].ordinal)
    for (const [id, original] of pending) {
      if (this.stopping) return
      if (blocked.has(original.target) || original.nextAttemptAt > this.now()) {
        blocked.add(original.target)
        continue
      }
      let record = original
      try {
        // The record schema accepts only Signal targets.
        const target = signalTargetOf(record.target) as SignalTarget
        while (record.cursor < record.parts.length) {
          await this.sendPart(target, record.parts[record.cursor] as string, record.cursor === 0 ? storedImage(record.image) : undefined)
          record = { ...record, cursor: record.cursor + 1 }
          await this.table.put(id, record)
        }
        await this.table.put(id, this.receipt(record))
      } catch (error: unknown) {
        blocked.add(record.target)
        await this.failed(id, record, error)
      }
    }
    await this.prune()
  }

  private receipt(record: OutboxRecord, abandoned?: string): OutboxRecord {
    const { image: _image, ...rest } = record
    return { ...rest, parts: [], cursor: 0, completedAt: this.now(), ...abandoned === undefined ? {} : { abandoned } }
  }

  private async failed(id: string, record: OutboxRecord, error: unknown): Promise<void> {
    const cause = failureText(error)
    const attempts = record.attempts + 1
    if (isPermanent(error) || attempts >= this.settings.maxAttempts) {
      const reason = `${isPermanent(error) ? 'permanent failure' : `${String(attempts)} failed attempts`}: ${cause}`.slice(0, 500)
      await this.table.put(id, this.receipt({ ...record, attempts }, reason))
      this.log.error(`signal-cli: delivery ${id} abandoned after ${reason}`)
      return
    }
    const delay = Math.min(this.settings.maxRetryMs, this.settings.retryMs * 2 ** (attempts - 1))
    await this.table.put(id, { ...record, attempts, nextAttemptAt: this.now() + delay })
    this.log.warn(`signal-cli: delivery ${id} stays queued; retrying in ${String(delay)} ms: ${cause}`)
  }

  private async prune(): Promise<void> {
    const receipts = [...this.table.entries()]
      .filter((entry): entry is [string, OutboxRecord & { completedAt: number }] => entry[1].completedAt !== undefined)
      .sort((left, right) => right[1].completedAt - left[1].completedAt)
    for (const [id] of receipts.slice(this.settings.maxReceipts)) await this.table.delete(id)
  }
}
