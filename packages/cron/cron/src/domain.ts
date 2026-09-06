/**
 * The durable job records of the scheduler: stored job definitions an agent or person created at
 * runtime, and per-job continuity state (notes and run history) that survives restarts for every
 * job, configured or stored. The schedule itself lives here; each run's full transcript lives in
 * its own Session.
 * @module @deepseek-ai/dsh-cron/domain
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** Where one job definition came from: plugin configuration or the durable store. */
export const jobOrigin = z.enum(['config', 'stored'])

/** Delivery target of a finished run's final text. */
export const jobDelivery = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('channel'), channelId: z.string().min(1) }),
])

/**
 * Durable shape of one runtime-created job. The key equals `name`. Config-origin jobs have no
 * row here; their definitions come from plugin configuration on every load.
 */
export const storedJobRecord = z.object({
  /** Unique job name, identical to the table key. */
  name: z.string().min(1),
  /** Cron expression, 5 or 6 fields as croner accepts them. */
  expression: z.string().min(1),
  /** IANA timezone the expression is evaluated in. */
  timezone: z.string().min(1),
  /** Prompt handed to the agent on every fire. */
  prompt: z.string().min(1),
  /** Agent preset mounted into the run's Session. */
  agentPreset: z.string().min(1),
  /** Permission preset applied to the run's Session. */
  permissionPreset: z.string().min(1),
  /** Absolute workspace path the run works in. */
  workspacePath: z.string().min(1),
  /** Session title override; absent means job name plus fire time. */
  title: z.string().optional(),
  /** Whether the schedule is armed; false keeps the definition and stops firing. */
  enabled: z.boolean(),
  /** Where a finished run's final text is delivered. */
  deliver: jobDelivery,
  /** Session that created the job, when a tool call created it. */
  createdBy: z.string().optional(),
  /** Epoch milliseconds of creation. */
  createdAt: z.number(),
})

/** One durable runtime-created job definition. */
export type StoredJobRecord = z.infer<typeof storedJobRecord>

/** The delivery target of one job, as stored or configured. */
export type JobDelivery = z.infer<typeof jobDelivery>

/** How one past run ended, kept in the job's history. */
export const runHistoryEntry = z.object({
  /** Epoch milliseconds of the fire that produced this run. */
  firedAt: z.number(),
  /** Session the run executed in; empty when the Session never opened. */
  sessionId: z.string(),
  /** How the run ended. */
  outcome: z.enum(['answered', 'no-text-answer', 'timed-out', 'failed']),
})

/** One retained entry of a job's run history. */
export type RunHistoryEntry = z.infer<typeof runHistoryEntry>

/**
 * Durable continuity state of one job, keyed by job name. Notes carry between runs so each fire
 * continues where the last left off; `lastRuns` is the bounded outcome ledger.
 */
export const jobStateRecord = z.object({
  /** Free-form notes the agent rewrites through the management tool; empty when none. */
  notes: z.string(),
  /** Most recent runs first, capped by the plugin's history bound. */
  lastRuns: z.array(runHistoryEntry),
})

/** One job's durable continuity state. */
export type JobStateRecord = z.infer<typeof jobStateRecord>

/** The cron domain spec: runtime job definitions plus per-job continuity state. */
export const cronDomainSpec = defineDomain({
  name: 'cron_jobs',
  version: 1,
  tables: {
    jobs: domainTable<string, StoredJobRecord>(storedJobRecord),
    state: domainTable<string, JobStateRecord>(jobStateRecord),
  },
})
