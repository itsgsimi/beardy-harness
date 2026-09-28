/**
 * Types of the global scheduler: the job name and fire time a fired job carries into its Session log, and
 * the outcome of one run.
 * @module @deepseek-ai/dsh-cron/types
 */

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** One prompt handed to an agent because a cron expression fired.
     * Readers preserve the message and attribution without the scheduler.
     * @persistenceAttribution
     */
    cron: {
      readonly kind: 'cron'
      /** Configured job name, unique within the plugin's job list. */
      readonly jobName: string
      /** Wall-clock time the expression matched, in epoch milliseconds. */
      readonly scheduledFor: number
      readonly form: 'notice'
      readonly summary: string
    }
  }
}

import type { ConfiguredModelSelection } from '@deepseek-ai/dsh-unattended-session'

/** One configured job, as validated plugin configuration delivers it. */
export interface CronJobSpec {
  /** Unique name, used in logs, Session titles, and the run's recorded source. */
  readonly name: string
  /** Cron expression, 5 or 6 fields as croner accepts them. */
  readonly expression: string
  /** IANA timezone the expression is evaluated in, such as `Europe/Zagreb`. */
  readonly timezone: string
  /** Prompt handed to the agent on every fire. */
  readonly prompt: string
  /** Agent preset mounted into the run's Session. */
  readonly agentPreset: string
  /** Permission preset applied to the run's Session. */
  readonly permissionPreset: string
  /** Absolute workspace path the run works in. */
  readonly workspacePath: string
  /** Session title; defaults to the job name followed by the fire time. */
  readonly title?: string
  /** Per-run turn bound in milliseconds; absent uses the plugin's turnTimeoutMs. */
  readonly turnTimeoutMs?: number
}

/** One configured job plus its channel-delivery target from plugin configuration. */
export interface ConfiguredCronJob extends CronJobSpec {
  /** Exact model choice for this configured job; overrides the cron-wide choice. */
  readonly modelSelection?: ConfiguredModelSelection | undefined
  /**
   * Delivery target for a finished run's final text: a Discord channel id, `discord:<id>`,
   * `signal:group:<base64 id>`, or `signal:number:<E.164>`; absent means none.
   */
  readonly deliverChannel?: string
}

/** One scheduled job as the runner receives it: the definition plus its continuity notes. */
export interface ScheduledJobSpec extends CronJobSpec {
  /** Configured job override; stored jobs inherit the cron-wide choice. */
  readonly modelSelection?: ConfiguredModelSelection | undefined
  /** Notes from earlier runs, injected under the prompt; empty when the job has none. */
  readonly notes: string
  /** Delivery target receiving the final answer through the scheduler's durable delivery handoff. */
  readonly deliverChannelId?: string
}

/** How one scheduled fire ended, retained in job history and delivery notices. */
export type CronRunOutcome = 'answered' | 'no-text-answer' | 'timed-out' | 'failed' | 'interrupted' | 'skipped'

/** What one settled fire reports back to the scheduler. */
export interface CronRunResult {
  /** How the fire ended. */
  readonly outcome: CronRunOutcome
  /** Outcome id; a skipped fire has no Session log. */
  readonly sessionId: string
  /** Final assistant text of the run; empty when there was none. */
  readonly text: string
  /** Failure or skip reason; absent when neither applies. */
  readonly failure?: { readonly code: string; readonly message: string }
}

/** A settled fire retained until delivery listeners durably accept its outcome. */
export interface CronRunFinished extends CronRunResult {
  /** Name of the job whose fire settled. */
  readonly jobName: string
  /** Epoch milliseconds of the scheduled or triggered fire. */
  readonly firedAt: number
  /** Delivery target; the owner of its transport claims it, and absent means no delivery. */
  readonly deliverChannelId?: string
  /** Whether an outcome without answer text should produce a notice. */
  readonly reportOutcome: boolean
  /** Next armed fire, resolved from the current job definition when delivery occurs. */
  readonly nextFireAt?: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One cron fire settled, carrying the text a delivery lane may forward. The scheduler emits it
     * after recording the outcome in the job's history; delivering to a channel belongs to whichever
     * listener owns one.
     * Listeners resolve after durably accepting delivery. A rejected listener leaves the outcome
     * pending for another handoff; listeners must deduplicate by outcome id and fire time.
     * @param payload - Persisted run result, job identity, fire time, and delivery policy.
     * @returns `true` after durable delivery acceptance, or undefined when the listener does not own delivery.
     * @mode serial
     */
    'cron/run-finished'(payload: CronRunFinished): true | undefined | Promise<true | undefined>
  }
}
