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
}

/** How one fired job ended, reported to logs only. */
export type CronRunOutcome = 'answered' | 'no-text-answer' | 'timed-out' | 'failed'

/** What one settled run reports back to the scheduler. */
export interface CronRunResult {
  /** How the run ended. */
  readonly outcome: CronRunOutcome
  /** Session the run executed in; empty when the Session never opened. */
  readonly sessionId: string
  /** Final assistant text of the run; empty when there was none. */
  readonly text: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One cron run settled, carrying the text a delivery lane may forward. The scheduler emits it
     * after recording the run in the job's history; delivering to a channel belongs to whichever
     * listener owns one.
     * @param payload.jobName - Name of the job whose run settled.
     * @param payload.sessionId - Session the run executed in; empty when it never opened.
     * @param payload.firedAt - Epoch milliseconds of the fire that started the run.
     * @param payload.outcome - How the run ended.
     * @param payload.text - Final assistant text; empty when there was none.
     * @param payload.deliverChannelId - Channel a finished run's text should reach; absent when the
     * job delivers nowhere.
     * @param payload.reportOutcome - Whether listeners announce an outcome line when `text` is
     * empty, per the scheduler's `deliverOutcomes` configuration.
     * @mode emit
     */
    'cron/run-finished'(payload: {
      jobName: string
      sessionId: string
      firedAt: number
      outcome: CronRunOutcome
      text: string
      deliverChannelId?: string
      reportOutcome: boolean
    }): void
  }
}
