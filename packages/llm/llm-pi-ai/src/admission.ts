/**
 * FIFO, abort-aware admission for one pi-ai provider route in this process.
 * The adapter owns one instance per route across configuration snapshots, so
 * active requests remain counted while settings replace their model catalogs.
 * @module dsh-llm-pi-ai/admission
 */

import { LlmError } from '@deepseek-ai/dsh-llm'

interface Waiter {
  readonly limit: number | undefined
  grant: (release: () => void) => void
}

/** One route's active-request count and FIFO waiters. */
export class ProviderAdmission {
  private active = 0
  private readonly waiters: Waiter[] = []

  /**
   * Reserve one provider request until the returned disposer is called. A
   * queued request retains its captured limit and timeout across settings
   * changes; active calls count against later snapshots of the same route.
   * @param provider - route name used in failure diagnostics.
   * @param limit - maximum active requests, or undefined for unlimited.
   * @param queueTimeoutMs - maximum queue wait, or undefined for no deadline.
   * @param signal - caller cancellation while waiting.
   * @returns an idempotent release function, called after stream teardown.
   * @throws LlmError with `ABORTED` or `ADMISSION_TIMEOUT` while queued.
   */
  acquire(
    provider: string,
    limit: number | undefined,
    queueTimeoutMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<() => void> {
    if ((limit !== undefined || this.waiters.length > 0) && signal?.aborted) {
      return Promise.reject(new LlmError(`pi-ai request for provider "${provider}" aborted while queued`, 'ABORTED'))
    }
    if (this.waiters.length === 0 && (limit === undefined || this.active < limit)) {
      this.active += 1
      return Promise.resolve(this.release())
    }

    return new Promise<() => void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const waiter: Waiter = { limit, grant: resolve }
      const remove = (): void => {
        // A waiter settles once: JS callbacks are serialized, and settlement
        // cancels the timer and detaches the abort listener before pumping.
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      const fail = (error: LlmError): void => {
        remove()
        reject(error)
        this.pump()
      }
      const onAbort = (): void => {
        fail(new LlmError(`pi-ai request for provider "${provider}" aborted while queued`, 'ABORTED'))
      }
      waiter.grant = (release) => {
        remove()
        resolve(release)
      }
      this.waiters.push(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (queueTimeoutMs !== undefined) {
        timer = setTimeout(() => {
          fail(new LlmError(
            `pi-ai provider "${provider}" admission queue timeout after ${queueTimeoutMs}ms`,
            'ADMISSION_TIMEOUT',
          ))
        }, queueTimeoutMs)
      }
    })
  }

  /** Give available slots to waiters in arrival order. */
  private pump(): void {
    while (this.waiters.length > 0) {
      const first = this.waiters[0] as Waiter
      if (first.limit !== undefined && this.active >= first.limit) return
      this.active += 1
      first.grant(this.release())
    }
  }

  /** Return a slot once, including when stream teardown calls more than once. */
  private release(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active -= 1
      this.pump()
    }
  }
}
