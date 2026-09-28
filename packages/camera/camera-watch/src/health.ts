/**
 * Classification failure tracking: which failed classifications call for a failure notice, at most
 * one such notice per interval, and one recovery line after the first answered classification that
 * follows it. State is process-local. Notice ids name the fixed interval window, aligned to the Unix
 * epoch, in which the failure notice was raised, so a restart inside that window hands the delivery
 * owner an id it already holds.
 * @module @deepseek-ai/dsh-camera-watch/health
 */

/** Failure codes meaning the model route itself is unusable; each one can raise a failure notice. */
export type RouteFailureCode = 'MODEL_UNAVAILABLE' | 'MODEL_NOT_VISION'

/** Turn failure codes that raise a failure notice once `failureNoticeThreshold` occur in a row. */
export const TURN_FAILURE_CODES: readonly string[] = Object.freeze(['TIMEOUT', 'TURN_FAILED', 'NO_ANSWER', 'SESSION_FAILED'])

/** Longest cause a failure notice quotes, in characters. */
const CAUSE_MAX_CHARS = 200

/**
 * Reduce a route failure to the innermost cause's first line, bounded to 200 characters, for a
 * failure notice. A null cause ends the chain like an absent one, and a cyclic chain stops at the last
 * error not seen before.
 * @param error - thrown route resolution failure.
 * @returns one bounded line.
 */
export function shortCause(error: unknown): string {
  const seen = new Set<unknown>([error])
  let current = error
  while (current instanceof Error && current.cause !== undefined && current.cause !== null && !seen.has(current.cause)) {
    current = current.cause
    seen.add(current)
  }
  const text = current instanceof Error ? current.message : String(current)
  const newline = text.indexOf('\n')
  const line = newline === -1 ? text : text.slice(0, newline)
  return line.length <= CAUSE_MAX_CHARS ? line : `${line.slice(0, CAUSE_MAX_CHARS - 1)}…`
}

/** A failure or recovery notice the watch logs and, with a channel, hands to `camera/notice`. */
export type HealthNotice =
  | {
    readonly kind: 'failing'
    /** `camera-watch:classification-failing:<window start in epoch ms>`. */
    readonly id: string
    readonly code: string
    /** Bounded one-line cause. */
    readonly cause: string
  }
  | {
    readonly kind: 'recovered'
    /** The failure notice id followed by `:recovered`. */
    readonly id: string
  }

/** Failure notice bounds from validated configuration. */
export interface HealthSettings {
  /** Turn failures in a row that raise a failure notice. */
  readonly threshold: number
  /** Least milliseconds between two failure notices; also the id window length. */
  readonly intervalMs: number
}

/** Process-local failure state of one camera watch. */
export class ClassificationHealth {
  private consecutive = 0
  private lastFailingAt: number | undefined
  /** Id of the latest failure notice no recovery line has followed yet. */
  private unrecovered: string | undefined

  /** @param settings - threshold and interval. */
  constructor(private readonly settings: HealthSettings) {}

  /**
   * Record an answered classification: the turn-failure run ends, and the first answer after a
   * failure notice yields the recovery line.
   * @returns the recovery notice, or undefined.
   */
  answered(): HealthNotice | undefined {
    this.consecutive = 0
    const failing = this.unrecovered
    if (failing === undefined) return undefined
    this.unrecovered = undefined
    return { kind: 'recovered', id: `${failing}:recovered` }
  }

  /**
   * Record an unusable model route, from an event or from the route check.
   * @param code - route failure code.
   * @param cause - bounded one-line cause.
   * @param now - current epoch milliseconds.
   * @returns the failure notice, or undefined inside the interval.
   */
  routeFailed(code: RouteFailureCode, cause: string, now: number): HealthNotice | undefined {
    return this.failing(code, cause, now)
  }

  /**
   * Record a classification turn that did not answer. Codes outside {@link TURN_FAILURE_CODES}
   * leave the state unchanged.
   * @param code - classification failure code.
   * @param now - current epoch milliseconds.
   * @returns the failure notice once the run reaches the threshold outside the interval, or undefined.
   */
  turnFailed(code: string, now: number): HealthNotice | undefined {
    if (!TURN_FAILURE_CODES.includes(code)) return undefined
    this.consecutive++
    if (this.consecutive < this.settings.threshold) return undefined
    return this.failing(code, `${String(this.consecutive)} classifications in a row`, now)
  }

  private failing(code: string, cause: string, now: number): HealthNotice | undefined {
    if (this.lastFailingAt !== undefined && now - this.lastFailingAt < this.settings.intervalMs) return undefined
    this.lastFailingAt = now
    const windowStart = Math.floor(now / this.settings.intervalMs) * this.settings.intervalMs
    const id = `camera-watch:classification-failing:${String(windowStart)}`
    this.unrecovered = id
    return { kind: 'failing', id, code, cause }
  }
}
