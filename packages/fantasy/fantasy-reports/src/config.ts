/** Validated per-team report schedules, delivery routes, and research bounds. @module @deepseek-ai/dsh-fantasy-reports/config */

import { isAbsolute } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { LeagueKey, TeamKey } from '@deepseek-ai/dsh-fantasy'
import type { LeagueKey as LeagueKeyType, TeamKey as TeamKeyType } from '@deepseek-ai/dsh-fantasy/types'
import { assertSchedule } from '@deepseek-ai/dsh-cron'
import { assertDeliveryTarget } from '@deepseek-ai/dsh-delivery-target'

/** Report timing; each mode has its own schedule and review emphasis. */
export type ReportMode = 'full' | 'thursday' | 'sunday'

/** Every report mode in schedule order. */
export const REPORT_MODES: readonly ReportMode[] = ['full', 'thursday', 'sunday']

/** One Yahoo team, its Discord destination, and its three weekly start times. */
export interface TeamConfig {
  /** Stable lowercase identity used in run keys and job names. */
  readonly id: string
  /** Display name used in report titles and shadow labels. */
  readonly name: string
  /** Yahoo team key; its league is the key's league prefix. */
  readonly teamKey: string
  /**
   * Delivery target for this team's reports outside shadow mode: a Discord channel id, `discord:<id>`,
   * `signal:group:<base64 id>`, or `signal:number:<E.164>`.
   */
  readonly channelId: string
  /** Cron expressions for the three weekly reports, in the configured timezone. */
  readonly schedule: ReportScheduleConfig
  /**
   * Agent presets that may request this team's report on demand; each must also be in the top-level
   * `commandPresets`. Absent or empty, every preset in `commandPresets` may request it.
   */
  readonly commandPresets?: string[]
}

/** One team's three weekly start times. */
export interface ReportScheduleConfig {
  /** Midweek full report, such as `0 14 * * 3` for Wednesday at 2:00 PM. */
  readonly full: string
  /** Thursday update focused on practice reports and early kickoffs. */
  readonly thursday: string
  /** Sunday update focused on final designations before kickoff. */
  readonly sunday: string
}

/** Deployment values. Teams, channels, and schedules have no defaults. */
export interface Config {
  /** IANA timezone for schedules, fire dates, and report timestamps. */
  readonly timezone: string
  /** Absolute workspace recorded on the caller, run, and stage Sessions. */
  readonly workspacePath: string
  /** Teams to report on. */
  readonly teams: TeamConfig[]
  /** First Yahoo game week that produces reports. */
  readonly firstWeek?: number
  /** Last Yahoo game week that produces reports. */
  readonly lastWeek?: number
  /** When set, every report and notice goes only to this delivery target, labeled with its team; same forms as `channelId`. */
  readonly shadowChannelId?: string
  /**
   * Agent presets whose Sessions may run the human `/fantasy-report` command. Empty, the default,
   * registers no command.
   */
  readonly commandPresets?: string[]
  /** Minimum milliseconds between two report starts. */
  readonly minimumStartGapMs?: number
  /**
   * How long after a team's latest slot a plugin start still revisits it: a missing or interrupted
   * report runs once, and a completed one is handed to delivery again; 0 turns catch-up off.
   */
  readonly catchUpWindowMs?: number
  /** Tighter catch-up window for Sunday slots, which must finish before the first kickoff. */
  readonly sundayCatchUpWindowMs?: number
  /** Search queries per roster player: availability first, then fantasy outlook. */
  readonly searchesPerPlayer?: number
  /** Search results considered per query. */
  readonly searchResultsPerQuery?: number
  /** Admitted pages kept per roster player. */
  readonly pagesPerPlayer?: number
  /** Concurrent player searches and fetches. */
  readonly maxConcurrentFetches?: number
  /** Characters rendered from one fetched page before admission. */
  readonly maxPageChars?: number
  /** Characters of one admitted page shown to a model, kept as passages around roster names. */
  readonly sourceExcerptChars?: number
  /** Characters of all admitted pages shown to the writer; each page's share never drops below 1,200. */
  readonly promptSourceChars?: number
  /** Hosts whose pages are never fetched; each entry also covers its subdomains. */
  readonly excludedHosts?: string[]
  /** Largest roster a report covers. */
  readonly maxPlayers?: number
  /** Output ceiling of the writer stage. */
  readonly writerMaxTokens?: number
  /** Output ceiling of each reviewer stage. */
  readonly reviewerMaxTokens?: number
  /** Output ceiling of each repair stage. */
  readonly repairMaxTokens?: number
  /** Factual reviews before the final-round rule applies. */
  readonly maxReviews?: number
  /** Structural repairs before publication is withheld. */
  readonly maxStructuralRepairs?: number
  /** Earlier completed reports of the same team and season shown as context. */
  readonly historyReports?: number
  /** Characters of earlier reports shown as context, shared by all of them. */
  readonly historyChars?: number
  /** Deadline of one model stage. */
  readonly stageTimeoutMs?: number
  /** Deadline of one complete report run. */
  readonly runTimeoutMs?: number
  /** Largest delivered report, including a shadow label. */
  readonly maxDeliveryChars?: number
  /** Delivery handoff attempts before a report stays undelivered. */
  readonly deliveryAttempts?: number
  /** Milliseconds between delivery handoff attempts. */
  readonly deliveryRetryMs?: number
}

/** A configured team with its checked Yahoo identities and the presets that may request it on demand. */
export interface ResolvedTeam extends Omit<TeamConfig, 'teamKey' | 'commandPresets'> {
  readonly teamKey: TeamKeyType
  readonly leagueKey: LeagueKeyType
  readonly commandPresets: readonly string[]
}

/** Complete report policy after every bound is applied and checked. */
export interface ResolvedConfig extends Required<Omit<Config, 'teams' | 'shadowChannelId' | 'excludedHosts' | 'commandPresets'>> {
  readonly teams: readonly ResolvedTeam[]
  readonly excludedHosts: readonly string[]
  readonly commandPresets: readonly string[]
  readonly shadowChannelId?: string
}

/** Default hosts whose pages are social, video, or encyclopedic rather than dated reporting. */
export const DEFAULT_EXCLUDED_HOSTS: readonly string[] = [
  'reddit.com', 'youtube.com', 'facebook.com', 'x.com', 'twitter.com', 'tiktok.com', 'instagram.com', 'wikipedia.org',
]

/** Default, minimum, and maximum of every numeric field. */
const BOUNDS = {
  firstWeek: [1, 1, 22], lastWeek: [17, 1, 22],
  minimumStartGapMs: [5_400_000, 0, 86_400_000],
  catchUpWindowMs: [43_200_000, 0, 604_800_000], sundayCatchUpWindowMs: [7_200_000, 0, 86_400_000],
  searchesPerPlayer: [2, 1, 2], searchResultsPerQuery: [4, 1, 20], pagesPerPlayer: [2, 1, 6],
  maxConcurrentFetches: [4, 1, 12], maxPageChars: [40_000, 1_000, 200_000], sourceExcerptChars: [5_000, 500, 20_000],
  promptSourceChars: [120_000, 5_000, 1_000_000],
  maxPlayers: [30, 1, 50],
  writerMaxTokens: [8_000, 256, 64_000], reviewerMaxTokens: [3_500, 256, 64_000], repairMaxTokens: [6_500, 256, 64_000],
  maxReviews: [3, 1, 6], maxStructuralRepairs: [2, 0, 6],
  historyReports: [2, 0, 6], historyChars: [6_000, 0, 40_000],
  stageTimeoutMs: [1_200_000, 1_000, 86_400_000], runTimeoutMs: [14_400_000, 1_000, 86_400_000],
  maxDeliveryChars: [19_000, 1_000, 20_000],
  deliveryAttempts: [3, 1, 10], deliveryRetryMs: [60_000, 0, 3_600_000],
} as const satisfies Record<string, readonly [number, number, number]>

type BoundKey = keyof typeof BOUNDS

/** Loader validation; {@link resolveConfig} repeats every check for direct callers. */
export const Config: z<Config> = z.object({
  timezone: z.string().required(),
  workspacePath: z.string().required(),
  teams: z.array(z.object({
    id: z.string().required(),
    name: z.string().required(),
    teamKey: z.string().required(),
    channelId: z.string().required(),
    schedule: z.object({
      full: z.string().required(), thursday: z.string().required(), sunday: z.string().required(),
    }).required(),
    commandPresets: z.array(z.string()),
  })).required(),
  shadowChannelId: z.string(),
  commandPresets: z.array(z.string()).default([]),
  excludedHosts: z.array(z.string()).default([...DEFAULT_EXCLUDED_HOSTS]),
  ...Object.fromEntries(Object.entries(BOUNDS).map(([key, [fallback, min, max]]) =>
    [key, z.number().step(1).min(min).max(max).default(fallback)])) as Record<BoundKey, z<number>>,
})

/** Reject a preset list with an invalid or repeated preset id. */
function presetList(presets: readonly string[], field: string): readonly string[] {
  if (presets.some(preset => !/^[a-z][a-z0-9-]*$/u.test(preset)) || new Set(presets).size !== presets.length) {
    throw new Error(`fantasy-reports: ${field} must be distinct preset ids`)
  }
  return presets
}

/**
 * Apply defaults and reject unusable routes, schedules, keys, and bounds at load.
 * @param config - loader or direct-caller configuration.
 * @returns complete policy for schedules, research, and delivery.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const bounds = {} as Record<BoundKey, number>
  for (const [key, [fallback, min, max]] of Object.entries(BOUNDS) as [BoundKey, readonly [number, number, number]][]) {
    const value = config[key] ?? fallback
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`fantasy-reports: ${key} must be an integer from ${min} through ${max}`)
    }
    bounds[key] = value
  }
  if (bounds.lastWeek < bounds.firstWeek) throw new Error('fantasy-reports: lastWeek must not precede firstWeek')
  if (!isAbsolute(config.workspacePath)) throw new Error('fantasy-reports: workspacePath must be absolute')
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.timezone })
  } catch {
    throw new Error(`fantasy-reports: timezone ${config.timezone} is not an IANA timezone`)
  }
  if (config.shadowChannelId !== undefined) assertDeliveryTarget(config.shadowChannelId, 'fantasy-reports: shadowChannelId')
  const excludedHosts = (config.excludedHosts ?? DEFAULT_EXCLUDED_HOSTS).map(host => host.trim().toLowerCase())
  if (excludedHosts.some(host => !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(host))) {
    throw new Error('fantasy-reports: excludedHosts must be host names')
  }
  if (config.teams.length === 0) throw new Error('fantasy-reports: teams must name at least one team')
  const commandPresets = presetList(config.commandPresets ?? [], 'commandPresets')
  const ids = new Set<string>()
  const keys = new Set<string>()
  const teams = config.teams.map((team): ResolvedTeam => {
    if (!/^[a-z][a-z0-9-]{0,39}$/u.test(team.id)) {
      throw new Error('fantasy-reports: team id must start with a letter and use lowercase letters, digits, or hyphens')
    }
    if (ids.has(team.id)) throw new Error(`fantasy-reports: duplicate team id ${team.id}`)
    ids.add(team.id)
    if (!team.name.trim() || team.name.length > 80) throw new Error(`fantasy-reports: team ${team.id} needs a name of 1 to 80 characters`)
    assertDeliveryTarget(team.channelId, `fantasy-reports: team ${team.id} channelId`)
    const teamKey = TeamKey(team.teamKey)
    if (keys.has(teamKey)) throw new Error(`fantasy-reports: duplicate team key ${teamKey}`)
    keys.add(teamKey)
    for (const mode of REPORT_MODES) assertSchedule(team.schedule[mode], config.timezone)
    const teamPresets = team.commandPresets === undefined || team.commandPresets.length === 0 ? commandPresets
      : presetList(team.commandPresets, `team ${team.id} commandPresets`)
    if (teamPresets.some(preset => !commandPresets.includes(preset))) {
      throw new Error(`fantasy-reports: team ${team.id} commandPresets must name presets from commandPresets`)
    }
    return { ...team, teamKey, leagueKey: LeagueKey(teamKey.replace(/\.t\.[0-9]+$/u, '')), commandPresets: teamPresets }
  })
  return {
    timezone: config.timezone, workspacePath: config.workspacePath, teams, excludedHosts, commandPresets, ...bounds,
    ...(config.shadowChannelId === undefined ? {} : { shadowChannelId: config.shadowChannelId }),
  }
}
