/**
 * Persisted Discord delivery with chunk checkpoints and restart-safe retries.
 * @module @deepseek-ai/dsh-discord-gateway/outbox
 */

import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { chunkContent, defangBroadcastMentions } from '@deepseek-ai/dsh-tool-discord'
import type { DiscordMessageBody } from '@deepseek-ai/dsh-tool-discord'
import { discordMessageBody } from './domain.ts'
import type { OutboxRecord } from './domain.ts'

/** Deployment bounds for retained deliveries and retry scheduling. */
export interface OutboxSettings {
  /** Maximum unfinished deliveries retained before enqueue refuses. */
  readonly outboxMaxPending: number
  /** Maximum UTF-16 units across text chunks or serialized rich bodies, including presentation fields. */
  readonly outboxMaxChars: number
  /** Initial retry delay after a failed delivery attempt. */
  readonly outboxRetryMs: number
  /** Ceiling on exponentially increased retry delays. */
  readonly outboxMaxRetryMs: number
  /** Completed delivery ids retained for duplicate suppression. */
  readonly outboxMaxReceipts: number
}

/** Persistent queue owner; enqueue promises durability, never network completion. */
export class DiscordOutbox {
  private timer: ReturnType<typeof setTimeout> | undefined
  private mutation: Promise<unknown> = Promise.resolve()
  private running: Promise<void> | undefined
  private stopping = false
  private retryAt = 0

  /**
   * Construct a queue; start recovers pending records, and enqueue schedules accepted deliveries.
   * @param table - Durable queue records, keyed by delivery id.
   * @param settings - Queue and retry bounds.
   * @param post - Posts one protocol-sized chunk and resolves only after acknowledgement.
   * @param warn - Reports a retained delivery failure.
   */
  constructor(
    private readonly table: KvTable<string, OutboxRecord>,
    private readonly settings: OutboxSettings,
    private readonly post: (channelId: string, content: string | DiscordMessageBody) => Promise<void>,
    private readonly warn: (message: string) => void,
  ) {}

  /** Start delivery of persisted records without running any agent. */
  start(): void { this.arm() }

  /**
   * Persist a complete delivery once, retaining its id through the receipt window.
   * @param id - Stable source identity, or a fresh id for a non-repeatable notice.
   * @param channelId - Destination Discord channel.
   * @param content - Complete text or already-rendered message bodies, persisted before any delivery attempt.
   */
  async enqueue(id: string, channelId: string, content: string | readonly DiscordMessageBody[]): Promise<void> {
    const operation = this.mutation.then(async () => {
      if (this.isStopping()) throw new Error('Discord outbox is stopping')
      if (this.table.get(id) !== undefined) return
      const chunks = typeof content === 'string'
        ? chunkContent(defangBroadcastMentions(content).content)
        : content.map(body => discordMessageBody.parse(body))
      const characters = chunks.reduce((total, chunk) => total + (typeof chunk === 'string'
        ? chunk.length : JSON.stringify(chunk).length), 0)
      if (characters === 0 || characters > this.settings.outboxMaxChars) {
        throw new Error(`Discord delivery must contain 1 to ${String(this.settings.outboxMaxChars)} characters`)
      }
      if (this.pending() >= this.settings.outboxMaxPending) throw new Error('Discord outbox is full; delivery was not queued')
      const now = Date.now()
      const ordinal = [...this.table.entries()].reduce((maximum, [, record]) => Math.max(maximum, record.ordinal), 0) + 1
      await this.table.put(id, { channelId, chunks, cursor: 0, ordinal, createdAt: now,
        nextAttemptAt: now, attempts: 0 })
    })
    this.mutation = operation.catch(() => {})
    await operation
    this.arm()
  }

  /**
   * Count unfinished deliveries.
   * @param channelId - Restrict the count to this channel when provided.
   * @returns the number of unfinished deliveries.
   */
  pending(channelId?: string): number {
    return [...this.table.entries()].filter(([, value]) => value.completedAt === undefined
      && (channelId === undefined || value.channelId === channelId)).length
  }

  /** Stop timers and wait for in-flight persistence and transport work to settle. */
  async dispose(): Promise<void> {
    this.stopping = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    await this.mutation
    await this.running
  }

  private isStopping(): boolean { return this.stopping }

  private arm(): void {
    if (this.isStopping() || this.running !== undefined) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    const channels = new Set<string>()
    const pending = [...this.table.entries()].filter(([, value]) => value.completedAt === undefined)
      .sort((left, right) => left[1].ordinal - right[1].ordinal)
      .filter(([, value]) => {
        if (channels.has(value.channelId)) return false
        channels.add(value.channelId)
        return true
      })
    if (pending.length === 0) return
    const next = Math.max(this.retryAt, Math.min(...pending.map(([, value]) => value.nextAttemptAt)))
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.running = this.drain().catch((error: unknown) => {
        this.retryAt = Date.now() + this.settings.outboxRetryMs
        this.warn(`Discord outbox persistence failed: ${String(error)}`)
      }).finally(() => {
        this.running = undefined
        this.arm()
      })
    }, Math.min(2_147_483_647, Math.max(0, next - Date.now())))
  }

  private async drain(): Promise<void> {
    const blockedChannels = new Set<string>()
    const records = [...this.table.entries()].filter(([, value]) => value.completedAt === undefined)
      .sort((left, right) => left[1].ordinal - right[1].ordinal)
    for (const [id, original] of records) {
      if (this.isStopping()) return
      if (blockedChannels.has(original.channelId)) continue
      if (original.nextAttemptAt > Date.now()) {
        blockedChannels.add(original.channelId)
        continue
      }
      let record = original
      try {
        while (record.cursor < record.chunks.length) {
          if (this.isStopping()) return
          // The durable schema bounds the cursor, and the loop requires an existing next chunk.
          // oxlint-disable-next-line typescript/no-non-null-assertion -- validated cursor and array length.
          const content = record.chunks[record.cursor]!
          await this.post(record.channelId, content)
          record = { ...record, cursor: record.cursor + 1 }
          await this.table.put(id, record)
        }
        await this.table.put(id, { ...record, chunks: [], cursor: 0, completedAt: Date.now() })
      } catch (error: unknown) {
        if (this.isStopping()) return
        blockedChannels.add(record.channelId)
        const attempts = Math.min(Number.MAX_SAFE_INTEGER, record.attempts + 1)
        const delay = Math.min(this.settings.outboxMaxRetryMs, this.settings.outboxRetryMs * 2 ** (attempts - 1))
        await this.table.put(id, { ...record, attempts, nextAttemptAt: Date.now() + delay })
        this.warn(`Discord delivery ${id} remains queued: ${String(error)}`)
      }
    }
    const receipts = [...this.table.entries()].filter((entry): entry is [string, OutboxRecord & { completedAt: number }] =>
      entry[1].completedAt !== undefined)
      .sort((left, right) => right[1].completedAt - left[1].completedAt)
    for (const [id] of receipts.slice(this.settings.outboxMaxReceipts)) await this.table.delete(id)
  }
}
