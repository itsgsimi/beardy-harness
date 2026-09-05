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

/** How one fired job ended, reported to logs only. */
export type CronRunOutcome = 'answered' | 'no-text-answer' | 'timed-out' | 'failed'
