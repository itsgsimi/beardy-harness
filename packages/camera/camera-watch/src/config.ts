/** Camera watch configuration and its cross-field validation. @module @deepseek-ai/dsh-camera-watch/config */

import { isAbsolute } from 'node:path'
import type { ConfiguredModelSelection } from '@deepseek-ai/dsh-unattended-session'
import z from '@deepseek-ai/schemastery'

/** Which classified events notify; every rule applies independently. */
export interface PolicyConfig {
  /** Notify every doorbell press, with or without a usable verdict; defaults to true. */
  readonly ding?: boolean
  /** Notify a verdict showing a package with the `delivering` activity; defaults to true. */
  readonly packageDelivered?: boolean
  /** Notify a person seen inside the night window; defaults to true. */
  readonly nightPerson?: boolean
  /** Night window start as local `HH:MM`; defaults to `21:00`. */
  readonly nightStart?: string
  /** Night window end as local `HH:MM`, possibly past midnight; defaults to `06:00`. */
  readonly nightEnd?: string
  /** Device ids whose vehicle sightings notify; defaults to none. */
  readonly vehicleDevices?: string[]
  /** Seconds between the first and last frame showing a person that count as lingering; defaults to 20. */
  readonly lingerSeconds?: number
  /** Lowest verdict confidence that can notify beyond a doorbell press; defaults to 0.5. */
  readonly minConfidence?: number
}

/** Camera watch configuration. */
export interface Config {
  /** IANA time zone for the night window, notices, and tool results. */
  readonly timezone: string
  /** Exact image-capable model route; absent uses the host default model at each event. */
  readonly modelSelection?: ConfiguredModelSelection | undefined
  /** Discord channel for notices; absent keeps history only. */
  readonly deliverChannelId?: string
  /** Absolute working directory recorded on classification Sessions. */
  readonly workspacePath?: string
  /** Notification rules. */
  readonly policy?: PolicyConfig
  /** Output token ceiling for one classification; defaults to 600. */
  readonly maxOutputTokens?: number
  /** Longest classification turn in milliseconds, including Session creation; defaults to 120000. */
  readonly turnTimeoutMs?: number
  /** Classifications running at once; defaults to 1. */
  readonly maxConcurrent?: number
  /** Events waiting for classification before new events are recorded unclassified; defaults to 10. */
  readonly maxQueued?: number
  /** Days an event stays in history; defaults to 30. */
  readonly retentionDays?: number
  /** Most events kept in history; defaults to 5000. */
  readonly maxHistory?: number
  /** Milliseconds between history retention sweeps; defaults to 3600000. */
  readonly sweepIntervalMs?: number
  /** Delivery handoff attempts per notice; defaults to 3. */
  readonly deliveryAttempts?: number
  /** Delay between delivery handoff attempts in milliseconds; defaults to 30000. */
  readonly deliveryRetryMs?: number
  /** Register the read-only `camera` model tool; defaults to true. */
  readonly tool?: boolean
  /** Most events one tool result lists; defaults to 50. */
  readonly toolMaxEvents?: number
}

/** Package defaults shared by the schema and {@link resolveConfig}. */
export const WATCH_DEFAULTS = Object.freeze({
  ding: true,
  packageDelivered: true,
  nightPerson: true,
  nightStart: '21:00',
  nightEnd: '06:00',
  lingerSeconds: 20,
  minConfidence: 0.5,
  maxOutputTokens: 600,
  turnTimeoutMs: 120_000,
  maxConcurrent: 1,
  maxQueued: 10,
  retentionDays: 30,
  maxHistory: 5_000,
  sweepIntervalMs: 3_600_000,
  deliveryAttempts: 3,
  deliveryRetryMs: 30_000,
  tool: true,
  toolMaxEvents: 50,
})

const modelSelectionSchema = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  reasoningEffort: z.union([z.string(), z.const(undefined)]),
})

/** Validated camera watch configuration. */
export const Config: z<Config> = z.object({
  timezone: z.string().required(),
  modelSelection: z.union([modelSelectionSchema, z.const(undefined)]),
  deliverChannelId: z.string(),
  workspacePath: z.string(),
  policy: z.object({
    ding: z.boolean().default(WATCH_DEFAULTS.ding),
    packageDelivered: z.boolean().default(WATCH_DEFAULTS.packageDelivered),
    nightPerson: z.boolean().default(WATCH_DEFAULTS.nightPerson),
    nightStart: z.string().default(WATCH_DEFAULTS.nightStart),
    nightEnd: z.string().default(WATCH_DEFAULTS.nightEnd),
    vehicleDevices: z.array(z.string()).default([]),
    lingerSeconds: z.number().min(1).default(WATCH_DEFAULTS.lingerSeconds),
    minConfidence: z.number().min(0).max(1).default(WATCH_DEFAULTS.minConfidence),
  }).default({}),
  maxOutputTokens: z.number().step(1).min(64).max(8_192).default(WATCH_DEFAULTS.maxOutputTokens),
  turnTimeoutMs: z.number().step(1).min(5_000).default(WATCH_DEFAULTS.turnTimeoutMs),
  maxConcurrent: z.number().step(1).min(1).max(8).default(WATCH_DEFAULTS.maxConcurrent),
  maxQueued: z.number().step(1).min(0).default(WATCH_DEFAULTS.maxQueued),
  retentionDays: z.number().step(1).min(1).max(3_650).default(WATCH_DEFAULTS.retentionDays),
  maxHistory: z.number().step(1).min(1).default(WATCH_DEFAULTS.maxHistory),
  sweepIntervalMs: z.number().step(1).min(60_000).default(WATCH_DEFAULTS.sweepIntervalMs),
  deliveryAttempts: z.number().step(1).min(1).max(20).default(WATCH_DEFAULTS.deliveryAttempts),
  deliveryRetryMs: z.number().step(1).min(1_000).default(WATCH_DEFAULTS.deliveryRetryMs),
  tool: z.boolean().default(WATCH_DEFAULTS.tool),
  toolMaxEvents: z.number().step(1).min(1).max(200).default(WATCH_DEFAULTS.toolMaxEvents),
})

/** Notification rules after defaults, with the night window in minutes after local midnight. */
export interface ResolvedPolicy {
  readonly ding: boolean
  readonly packageDelivered: boolean
  readonly nightPerson: boolean
  readonly nightStartMinute: number
  readonly nightEndMinute: number
  readonly vehicleDevices: readonly string[]
  readonly lingerMs: number
  readonly minConfidence: number
}

/** Complete watch settings after defaults and cross-field validation. */
export interface ResolvedConfig {
  readonly timezone: string
  readonly modelSelection?: ConfiguredModelSelection
  readonly deliverChannelId?: string
  readonly workspacePath?: string
  readonly policy: ResolvedPolicy
  readonly maxOutputTokens: number
  readonly turnTimeoutMs: number
  readonly maxConcurrent: number
  readonly maxQueued: number
  readonly retentionMs: number
  readonly maxHistory: number
  readonly sweepIntervalMs: number
  readonly deliveryAttempts: number
  readonly deliveryRetryMs: number
  readonly tool: boolean
  readonly toolMaxEvents: number
}

function minuteOf(value: string, field: string): number {
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/u.exec(value)
  if (match === null) throw new Error(`camera-watch: policy.${field} must be HH:MM in 24-hour time`)
  return Number(match[1]) * 60 + Number(match[2])
}

/**
 * Apply defaults and reject what the schema cannot: an unknown time zone, a malformed or empty night
 * window, a non-snowflake channel, and a relative workspace path. Device references are checked
 * against the camera provider when the watch starts.
 * @param config - schema-resolved configuration.
 * @returns complete watch settings.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.timezone })
  } catch {
    // Intl reports only RangeError for an unknown zone; the configured value is the useful detail.
    throw new Error(`camera-watch: timezone "${config.timezone}" is not a known IANA time zone`)
  }
  if (config.deliverChannelId !== undefined && !/^\d{17,20}$/u.test(config.deliverChannelId)) {
    throw new Error('camera-watch: deliverChannelId must be a Discord snowflake of 17 to 20 digits')
  }
  if (config.workspacePath !== undefined && !isAbsolute(config.workspacePath)) {
    throw new Error('camera-watch: workspacePath must be absolute')
  }
  const policy = config.policy ?? {}
  const nightStartMinute = minuteOf(policy.nightStart ?? WATCH_DEFAULTS.nightStart, 'nightStart')
  const nightEndMinute = minuteOf(policy.nightEnd ?? WATCH_DEFAULTS.nightEnd, 'nightEnd')
  if (nightStartMinute === nightEndMinute) throw new Error('camera-watch: policy.nightStart and policy.nightEnd must differ')
  return {
    timezone: config.timezone,
    ...config.modelSelection === undefined ? {} : { modelSelection: config.modelSelection },
    ...config.deliverChannelId === undefined ? {} : { deliverChannelId: config.deliverChannelId },
    ...config.workspacePath === undefined ? {} : { workspacePath: config.workspacePath },
    policy: {
      ding: policy.ding ?? WATCH_DEFAULTS.ding,
      packageDelivered: policy.packageDelivered ?? WATCH_DEFAULTS.packageDelivered,
      nightPerson: policy.nightPerson ?? WATCH_DEFAULTS.nightPerson,
      nightStartMinute,
      nightEndMinute,
      vehicleDevices: [...new Set(policy.vehicleDevices ?? [])],
      lingerMs: (policy.lingerSeconds ?? WATCH_DEFAULTS.lingerSeconds) * 1_000,
      minConfidence: policy.minConfidence ?? WATCH_DEFAULTS.minConfidence,
    },
    maxOutputTokens: config.maxOutputTokens ?? WATCH_DEFAULTS.maxOutputTokens,
    turnTimeoutMs: config.turnTimeoutMs ?? WATCH_DEFAULTS.turnTimeoutMs,
    maxConcurrent: config.maxConcurrent ?? WATCH_DEFAULTS.maxConcurrent,
    maxQueued: config.maxQueued ?? WATCH_DEFAULTS.maxQueued,
    retentionMs: (config.retentionDays ?? WATCH_DEFAULTS.retentionDays) * 86_400_000,
    maxHistory: config.maxHistory ?? WATCH_DEFAULTS.maxHistory,
    sweepIntervalMs: config.sweepIntervalMs ?? WATCH_DEFAULTS.sweepIntervalMs,
    deliveryAttempts: config.deliveryAttempts ?? WATCH_DEFAULTS.deliveryAttempts,
    deliveryRetryMs: config.deliveryRetryMs ?? WATCH_DEFAULTS.deliveryRetryMs,
    tool: config.tool ?? WATCH_DEFAULTS.tool,
    toolMaxEvents: config.toolMaxEvents ?? WATCH_DEFAULTS.toolMaxEvents,
  }
}
