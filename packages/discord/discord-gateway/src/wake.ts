/**
 * Timers that resume only Discord-owned sessions with pending durable reminders.
 * @module @deepseek-ai/dsh-discord-gateway/wake
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { foldScheduleEvents } from '@deepseek-ai/dsh-schedule'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ConversationRecord } from './domain.ts'

/** Cold-session timer owner; the resumed session's Schedule plugin dispatches its own reminders. */
export class DiscordWakeCoordinator {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly tasks = new Set<Promise<void>>()
  private readonly controller = new AbortController()

  /**
   * Construct an inactive coordinator.
   * @param ctx - Host session persistence and diagnostics.
   * @param table - Discord-owned session routing records.
   * @param wake - Serializes a resume with that channel's inbound work.
   * @param isLive - Whether the gateway already owns a live agent for the channel.
   * @param retryMs - Retry delay after a failed read or resume.
   */
  constructor(
    private readonly ctx: Context,
    private readonly table: KvTable<string, ConversationRecord>,
    private readonly wake: (record: ConversationRecord) => Promise<void>,
    private readonly isLive: (channelId: string) => boolean,
    private readonly retryMs: number,
  ) {}

  /** Inspect only registered Discord conversations and arm their earliest pending reminders. */
  async start(): Promise<void> {
    for (const [channelId] of this.table.entries()) {
      if (this.controller.signal.aborted) return
      await this.refresh(channelId)
    }
  }

  /**
   * Cancel one cold timer when the session becomes live or its conversation is replaced.
   * @param channelId - Channel whose timer is cancelled.
   */
  cancel(channelId: string): void {
    const timer = this.timers.get(channelId)
    if (timer !== undefined) clearTimeout(timer)
    this.timers.delete(channelId)
  }

  /**
   * Rebuild the cold timer from the session log after its live agent has been released.
   * @param channelId - Channel whose persisted session is inspected.
   */
  async refresh(channelId: string): Promise<void> {
    const task = this.refreshRecord(channelId)
    this.tasks.add(task)
    try { await task } finally { this.tasks.delete(task) }
  }

  private async refreshRecord(channelId: string): Promise<void> {
    this.cancel(channelId)
    if (this.controller.signal.aborted || this.isLive(channelId)) return
    const record = this.table.get(channelId)
    if (record === undefined) return
    try {
      const handle = await this.ctx.sessionPersistence.open(SessionId(record.sessionId), 'read', { signal: this.controller.signal })
      let next: number | undefined
      try {
        const events = await handle.read(handle.inheritedEventCount, undefined, { signal: this.controller.signal })
        next = foldScheduleEvents(events).active.reduce<number | undefined>((earliest, item) => {
          const time = Date.parse(item.scheduledAt)
          return earliest === undefined ? time : Math.min(earliest, time)
        }, undefined)
      } finally {
        await handle.close()
      }
      if (next !== undefined) this.arm(record, next)
    } catch (error: unknown) {
      this.retry(record, error)
    }
  }

  /** Cancel timers and reads, and wait until every started wake has settled. */
  async dispose(): Promise<void> {
    this.controller.abort()
    for (const [channelId] of this.timers) this.cancel(channelId)
    await Promise.allSettled([...this.tasks])
  }

  private retry(record: ConversationRecord, error: unknown): void {
    if (this.controller.signal.aborted) return
    this.ctx.logger.warn(`discord-gateway: reminder recovery for ${record.sessionId} will retry: ${String(error)}`)
    this.arm(record, Date.now() + this.retryMs, true)
  }

  private arm(record: ConversationRecord, target: number, refresh = false): void {
    if (this.controller.signal.aborted || this.isLive(record.channelId)
      || this.table.get(record.channelId)?.sessionId !== record.sessionId) return
    this.cancel(record.channelId)
    const timer = setTimeout(() => {
      this.timers.delete(record.channelId)
      const task = (async () => {
        if (refresh || Date.now() < target) {
          await this.refresh(record.channelId)
          return
        }
        try {
          await this.wake(record)
        } catch (error: unknown) {
          this.retry(record, error)
        }
      })()
      this.tasks.add(task)
      void task.then(() => this.tasks.delete(task))
    }, Math.min(2_147_483_647, Math.max(0, target - Date.now())))
    this.timers.set(record.channelId, timer)
  }
}
