/**
 * Turn-boundary helpers for unattended Sessions: the delay seam, a bounded wait for one admitted
 * turn, and reading that turn's final assistant text back out of the session log.
 * @module @deepseek-ai/dsh-unattended-session/turn
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Sleep until `ms` passes or the signal aborts.
 * @param ms - delay in milliseconds.
 * @param signal - cancellation that rejects the sleep with its own reason.
 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('unattended session wait cancelled'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Options for one bounded turn wait. */
export interface AwaitTurnOptions {
  /** Longest wait for the Agent to go idle before reporting `'timeout'`. */
  readonly timeoutMs: number
  /** Cancellation of the operation that admitted the turn; an abort reports `'timeout'`. */
  readonly signal: AbortSignal
  /** Delay seam used by the bound. Defaults to {@link sleep}. */
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>
}

/**
 * Wait for one admitted turn to settle within the bound. Bound expiry, a rejected delay seam, and a
 * failed turn all report `'timeout'`, so the caller releases the Agent through one path.
 * @param agent - Agent running the admitted turn.
 * @param options - bound, cancellation, and the optional delay seam.
 * @returns `'idle'` when the turn settled, `'timeout'` otherwise.
 */
export async function awaitTurn(agent: Agent, options: AwaitTurnOptions): Promise<'idle' | 'timeout'> {
  const wait = options.wait ?? sleep
  return new Promise<'idle' | 'timeout'>((resolve) => {
    void wait(options.timeoutMs, options.signal).then(
      () => { resolve('timeout') },
      () => { resolve('timeout') },
    )
    agent.whenIdle().then(() => { resolve('idle') }, () => { resolve('timeout') })
  })
}

/**
 * Last assistant text committed at or after `firstSeq`.
 * @param events - session events to scan.
 * @param firstSeq - seq of the turn's first event; earlier events are ignored.
 * @returns the final non-empty assistant text, or the empty string when the turn produced none.
 */
export function lastAssistantText(events: readonly SessionEvent[], firstSeq: number): string {
  let text = ''
  for (const event of events) {
    if (event.seq < firstSeq || event.type !== 'assistant/message') continue
    const joined = event.data.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    if (joined !== '') text = joined
  }
  return text
}
