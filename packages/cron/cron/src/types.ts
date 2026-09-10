/**
 * Types of the global scheduler: the cron provenance a fired job carries into its Session log, and
 * the outcome of one run.
 * @module @deepseek-ai/dsh-cron/types
 */

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** One prompt handed to an agent because a cron expression fired. */
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

/** One configured job, as validated plugin configuration delivers it. */
export interface CronJobSpec {
  /** Unique name, used in logs, Session titles, and the run's provenance. */
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
}

/** One configured job plus its channel-delivery target from plugin configuration. */
export interface ConfiguredCronJob extends CronJobSpec {
  /** Channel id where a finished run's final text is delivered; absent means none. */
  readonly deliverChannel?: string
}

/** One scheduled job as the runner receives it: the definition plus its continuity notes. */
export interface ScheduledJobSpec extends CronJobSpec {
  /** Notes from earlier runs, injected under the prompt; empty when the job has none. */
  readonly notes: string
  /** Channel receiving the final answer through the scheduler's durable delivery handoff. */
  readonly deliverChannelId?: string
}

/** How one accepted fire ended, retained in job history and delivery notices. */
export type CronRunOutcome = 'answered' | 'no-text-answer' | 'timed-out' | 'failed' | 'interrupted'

/** What one settled run reports back to the scheduler. */
export interface CronRunResult {
  /** How the run ended. */
  readonly outcome: CronRunOutcome
  /** Reserved Session id; its log may be absent when creation failed. */
  readonly sessionId: string
  /** Final assistant text of the run; empty when there was none. */
  readonly text: string
}

/** A settled run retained until delivery listeners durably accept its outcome. */
export interface CronRunFinished extends CronRunResult {
  /** Name of the job whose run settled. */
  readonly jobName: string
  /** Epoch milliseconds of the fire that started the run. */
  readonly firedAt: number
  /** Channel destination; absent means no channel delivery. */
  readonly deliverChannelId?: string
  /** Whether an empty answer should produce an outcome notice. */
  readonly reportOutcome: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One cron run settled, carrying the text a delivery lane may forward. The scheduler emits it
     * after recording the run in the job's history; delivering to a channel belongs to whichever
     * listener owns one.
     * Listeners resolve after durably accepting delivery. A rejected listener leaves the outcome
     * pending for another handoff; listeners must deduplicate by Session id and fire time.
     * @param payload - Persisted run result, job identity, fire time, and delivery policy.
     * @returns `true` after durable delivery acceptance, or undefined when the listener does not own delivery.
     * @mode serial
     */
    'cron/run-finished'(payload: CronRunFinished): true | undefined | Promise<true | undefined>
  }
}
