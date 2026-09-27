/**
 * Model-facing Discord listener: direct messages from allowed users become Agent Sessions, and the
 * agent's answer is posted back to the channel they wrote in. The Gateway websocket, the allowlists,
 * and the presets are deployment configuration; a caller in Discord cannot widen any of them.
 * @module @deepseek-ai/dsh-discord-gateway
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ConfiguredModelSelection } from '@deepseek-ai/dsh-unattended-session'
import type { HealthStatus } from '@deepseek-ai/dsh-health'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import { isAbsolute } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { sleep } from '@deepseek-ai/dsh-unattended-session'
import { errorChain } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { attachCronDelivery, createConversationRouter } from './conversation.ts'
import type { ConversationRouter, RoutingPolicy } from './conversation.ts'
import { discordGatewayDomainSpec } from './domain.ts'
import { connectDiscordGateway, DISCORD_GATEWAY_INTENTS } from './gateway.ts'
import type { DiscordGatewayOptions, GatewaySocketFactory } from './gateway.ts'
import type { ConversationLane, DiscordCommandActor, GatewaySettings, LaneToolFilter } from './types.ts'
import { discordCommands } from './commands.ts'
import { buildDiscordCommandCatalog, synchronizeDiscordCommands } from './interactions.ts'
import { createNativeInteractions } from './native.ts'

export * from './conversation.ts'
export * from './commands.ts'
export * from './domain.ts'
export * from './gateway.ts'
export * from './interactions.ts'
export * from './native.ts'
export * from './presentation.ts'
export type * from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'discord-gateway'

/** Services the listener creates Sessions through. */
export const inject = [
  'agentDefaultModel',
  'agentPresets',
  'agents',
  'commands',
  'credentials',
  'permissionPresets',
  'sessionTitle',
  'storageDomain',
  'sessions',
  'sessionPersistence',
  'workspaceRegistry',
]

/** Default per-turn bound: an answer that has not settled by then is not posted. */
export const DEFAULT_DISCORD_TURN_TIMEOUT_MS = 600_000

/** Default ceiling on inbound text handed to the agent. */
export const DEFAULT_DISCORD_MAX_INPUT_CHARS = 8_000

/** Default first reconnect delay; consecutive failures double it. */
export const DEFAULT_DISCORD_RECONNECT_DELAY_MS = 1_000

/** Default cap on the doubled reconnect delay. */
export const DEFAULT_DISCORD_MAX_RECONNECT_DELAY_MS = 30_000

/** Default silence after which the live Agent handle is released; the durable record stays. */
export const DEFAULT_DISCORD_IDLE_RELEASE_MS = 900_000

/** Default silence after which the next message starts a fresh Session. */
export const DEFAULT_DISCORD_CONVERSATION_MAX_AGE_MS = 86_400_000

/** Default window in which one channel's messages join into one turn. */
export const DEFAULT_DISCORD_INBOUND_DEBOUNCE_MS = 3_000

/** Default wait for an approval answer before the request reports cancelled. */
export const DEFAULT_DISCORD_APPROVAL_TIMEOUT_MS = 600_000

/** Default wait for one question's answer before the request rejects unanswered. */
export const DEFAULT_DISCORD_QUESTION_TIMEOUT_MS = 600_000

/** Session settings that replace the default lane for one allowlisted user's direct messages. */
export interface UserLaneConfig {
  /** Absolute workspace path the user's conversations run in. */
  readonly workspacePath: string
  /** Agent preset mounted into the user's conversation Sessions. */
  readonly agentPreset: string
  /** Permission preset applied to the user's conversation Sessions. */
  readonly permissionPreset: string
  /** Tool restriction for the user's conversation Agents; every name must be visible when a Session opens. Defaults to none. */
  readonly toolFilter?: LaneToolFilter | undefined
  /** Preset commands refused for this user in addition to `excludedPresetCommands`. Defaults to none. */
  readonly excludedPresetCommands?: string[]
}

/** Plugin configuration. Destinations, identity, and presets are never model input. */
export interface Config {
  /** Render command and lifecycle notices as Discord cards. */
  readonly richMessages?: boolean
  /** Preset commands unavailable in Discord. Defaults to the Web-only export command. */
  readonly excludedPresetCommands?: string[]
  /** Accent color of Discord cards. */
  readonly accentColor?: number
  /** Mark admitted messages with processing and completion reactions. */
  readonly reactionStatus?: boolean
  /** Per-attempt outbound HTTP bound. */
  readonly replyRequestTimeoutMs?: number
  /** Additional rate-limit retries for immediate replies. */
  readonly replyMaxRetries?: number
  /** Longest accepted server-requested retry delay. */
  readonly replyMaxRetryWaitMs?: number
  /** Maximum chunks of an immediate reply. */
  readonly replyMaxChunksPerCall?: number
  /** Maximum simultaneous native interactions. */
  readonly interactionMaxPending?: number
  /** Completed native interaction ids retained to suppress duplicate delivery. */
  readonly interactionReceiptLimit?: number
  /** Own and synchronize this application's global command menu. Defaults to true. */
  readonly nativeCommands?: boolean
  /** Delay before retrying a failed command-menu sync. Defaults to 30000. */
  readonly commandSyncRetryMs?: number
  /** Credential reference holding the bot token, such as `DISCORD_BOT_TOKEN`. */
  readonly tokenEnv: string
  /** User ids allowed to converse. Must be non-empty: an open listener is not a supported mode. */
  readonly allowedUserIds: string[]
  /** Guild text channels to read in addition to direct messages. Defaults to none. */
  readonly allowedChannelIds?: string[]
  /** Absolute workspace path every conversation runs in. */
  readonly workspacePath: string
  /** Agent preset mounted into each conversation Session. */
  readonly agentPreset: string
  /** Permission preset applied to each conversation Session. */
  readonly permissionPreset: string
  /** Exact route and effort for new Discord Sessions; omission inherits the current default. */
  readonly modelSelection?: ConfiguredModelSelection | undefined
  /** Tool restriction for default-lane conversation Agents; every name must be visible when a Session opens. Defaults to none. */
  readonly toolFilter?: LaneToolFilter | undefined
  /**
   * Own lanes keyed by allowlisted user id. That user's direct messages run with the lane's
   * workspace, presets, tool restriction, and command exclusions, and the user is not admitted in
   * guild channels. Defaults to none.
   */
  readonly userLanes?: Record<string, UserLaneConfig>
  /** Prefix of the generated Session title. Defaults to `Discord`. */
  readonly titlePrefix?: string
  /** Longest inbound text handed to the agent. Defaults to 8000. */
  readonly maxInputChars?: number
  /** Longest wait for one answer. Defaults to 600000. */
  readonly turnTimeoutMs?: number
  /** First reconnect delay in milliseconds. Defaults to 1000. */
  readonly reconnectDelayMs?: number
  /** Cap on the doubled reconnect delay. Defaults to 30000. */
  readonly maxReconnectDelayMs?: number
  /** Silence after which the live Agent handle is released; the record stays and the next message resumes. Defaults to 900000. */
  readonly idleReleaseMs?: number
  /** Silence after which the next message starts a fresh Session and replaces the record. Defaults to 86400000. */
  readonly conversationMaxAgeMs?: number
  /** Window in which one channel's messages join into a single turn; `0` answers each message. Defaults to 3000. */
  readonly inboundDebounceMs?: number
  /** Answer guild-channel messages only when the bot is mentioned or replied to. Defaults to true. */
  readonly guildRequireMention?: boolean
  /** Send the typing indicator while an inbound turn runs. Defaults to true. */
  readonly typingIndicator?: boolean
  /** Longest wait for an approval answer in milliseconds. Defaults to 600000. */
  readonly approvalTimeoutMs?: number
  /** Longest wait for one question's answer in milliseconds. Defaults to 600000. */
  readonly questionTimeoutMs?: number
  /** Reply forms: `component`, `reaction`, and `text`. Defaults to all three. */
  readonly answerers?: string[]
  /** Connect at mount. Set false to mount the plugin without dialing out. Defaults to true. */
  readonly enabled?: boolean
  /** Maximum queued, unfinished deliveries. Defaults to 100. */
  readonly outboxMaxPending?: number
  /** Maximum UTF-16 units per delivery: rewritten text or serialized rich message bodies. Defaults to 20000. */
  readonly outboxMaxChars?: number
  /** Initial delivery retry delay in milliseconds. Defaults to 1000. */
  readonly outboxRetryMs?: number
  /** Maximum delivery retry delay in milliseconds. Defaults to 60000. */
  readonly outboxMaxRetryMs?: number
  /** Completed delivery ids retained to suppress replays. Defaults to 1000. */
  readonly outboxMaxReceipts?: number
  /** Retry delay for a failed reminder read or resume. Defaults to 30000. */
  readonly wakeRetryMs?: number
}

// Preserve omission; Schemastery's `{ allow: [] }` default would hide every tool.
const toolFilterSchema = z.transform(z.object({
  allow: z.union([z.array(z.string()), z.const(undefined)]),
  deny: z.union([z.array(z.string()), z.const(undefined)]),
}), (filter): LaneToolFilter => ({
  ...(Array.isArray(filter.allow) ? { allow: filter.allow } : {}),
  ...(Array.isArray(filter.deny) ? { deny: filter.deny } : {}),
}))
const optionalToolFilterSchema = z.union([toolFilterSchema, z.const(undefined)])

export const Config: z<Config> = z.object({
  richMessages: z.boolean().default(true),
  excludedPresetCommands: z.array(z.string()).default(['export']),
  accentColor: z.number().min(0).max(0xffffff).default(0x5865f2),
  reactionStatus: z.boolean().default(true),
  replyRequestTimeoutMs: z.number().min(1).default(15000),
  replyMaxRetries: z.number().min(0).default(2),
  replyMaxRetryWaitMs: z.number().min(0).default(30000),
  replyMaxChunksPerCall: z.number().min(1).default(10),
  interactionMaxPending: z.number().min(1).default(100),
  interactionReceiptLimit: z.number().min(1).default(1000),
  nativeCommands: z.boolean().default(true),
  commandSyncRetryMs: z.number().min(1).default(30000),
  tokenEnv: z.string().role('credential-ref').required(),
  allowedUserIds: z.array(z.string()).required(),
  allowedChannelIds: z.array(z.string()).default([]),
  workspacePath: z.string().required(),
  agentPreset: z.string().required(),
  permissionPreset: z.string().required(),
  modelSelection: z.union([z.object({
    provider: z.string().required(),
    model: z.string().required(),
    reasoningEffort: z.union([z.string(), z.const(undefined)]),
  }), z.const(undefined)]),
  toolFilter: optionalToolFilterSchema,
  userLanes: z.dict(z.object({
    workspacePath: z.string().required(),
    agentPreset: z.string().required(),
    permissionPreset: z.string().required(),
    toolFilter: optionalToolFilterSchema,
    excludedPresetCommands: z.array(z.string()).default([]),
  })).default({}),
  titlePrefix: z.string().default('Discord'),
  maxInputChars: z.number().min(200).default(DEFAULT_DISCORD_MAX_INPUT_CHARS),
  turnTimeoutMs: z.number().min(1_000).default(DEFAULT_DISCORD_TURN_TIMEOUT_MS),
  reconnectDelayMs: z.number().min(1).default(DEFAULT_DISCORD_RECONNECT_DELAY_MS),
  maxReconnectDelayMs: z.number().min(1).default(DEFAULT_DISCORD_MAX_RECONNECT_DELAY_MS),
  idleReleaseMs: z.number().min(1_000).default(DEFAULT_DISCORD_IDLE_RELEASE_MS),
  conversationMaxAgeMs: z.number().min(1_000).default(DEFAULT_DISCORD_CONVERSATION_MAX_AGE_MS),
  inboundDebounceMs: z.number().min(0).default(DEFAULT_DISCORD_INBOUND_DEBOUNCE_MS),
  guildRequireMention: z.boolean().default(true),
  typingIndicator: z.boolean().default(true),
  approvalTimeoutMs: z.number().min(1_000).default(DEFAULT_DISCORD_APPROVAL_TIMEOUT_MS),
  questionTimeoutMs: z.number().min(1_000).default(DEFAULT_DISCORD_QUESTION_TIMEOUT_MS),
  answerers: z.array(z.string()).default(['component', 'reaction', 'text']),
  enabled: z.boolean().default(true),
  outboxMaxPending: z.number().min(1).default(100),
  outboxMaxChars: z.number().min(1).default(20_000),
  outboxRetryMs: z.number().min(1).default(1_000),
  outboxMaxRetryMs: z.number().min(1).default(60_000),
  outboxMaxReceipts: z.number().min(1).default(1_000),
  wakeRetryMs: z.number().min(1).default(30_000),
})

/** One user lane after schemastery applies its defaults; `toolFilter` stays optional. */
export type ResolvedUserLane = Required<Omit<UserLaneConfig, 'toolFilter'>> & Pick<UserLaneConfig, 'toolFilter'>

/** Complete configuration after schemastery applies every field default; `toolFilter` stays optional. */
export type ResolvedConfig = Required<Omit<Config, 'toolFilter' | 'userLanes' | 'modelSelection'>>
  & Pick<Config, 'toolFilter' | 'modelSelection'> & {
    readonly userLanes: Record<string, ResolvedUserLane>
  }

/** A Discord user or channel id is a snowflake: 17 to 20 decimal digits. */
const SNOWFLAKE_PATTERN = /^\d{17,20}$/

/**
 * Reject configuration that would listen for nobody, write outside a workspace, or wait unboundedly.
 * @param config - Complete configuration after defaults have been applied.
 */
export function assertConfig(config: ResolvedConfig): void {
  if (config.allowedUserIds.length === 0) {
    throw new Error('discord-gateway: allowedUserIds must name at least one Discord user')
  }
  for (const [field, ids] of [['allowedUserIds', config.allowedUserIds], ['allowedChannelIds', config.allowedChannelIds]] as const) {
    for (const id of ids) {
      if (!SNOWFLAKE_PATTERN.test(id)) {
        throw new Error(`discord-gateway: ${field} must each be a Discord snowflake of 17 to 20 digits, got "${id}"`)
      }
    }
  }
  if (!isAbsolute(config.workspacePath)) {
    throw new Error(`discord-gateway: workspacePath must be absolute, got "${config.workspacePath}"`)
  }
  assertToolFilter('toolFilter', config.toolFilter)
  for (const [userId, lane] of Object.entries(config.userLanes)) {
    if (!config.allowedUserIds.includes(userId)) {
      throw new Error(`discord-gateway: userLanes names "${userId}", which allowedUserIds does not admit`)
    }
    if (!isAbsolute(lane.workspacePath)) {
      throw new Error(`discord-gateway: userLanes.${userId}.workspacePath must be absolute, got "${lane.workspacePath}"`)
    }
    assertToolFilter(`userLanes.${userId}.toolFilter`, lane.toolFilter)
    assertPresetCommands(`userLanes.${userId}.excludedPresetCommands`, lane.excludedPresetCommands)
  }
  for (const [field, value] of Object.entries(config)) {
    if (['inboundDebounceMs', 'replyMaxRetries', 'replyMaxRetryWaitMs', 'accentColor'].includes(field)) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`discord-gateway: ${field} must be a non-negative safe integer`)
      }
      continue
    }
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`discord-gateway: ${field} must be a positive safe integer`)
    }
  }
  if (config.accentColor > 0xffffff) throw new Error('discord-gateway: accentColor must be a 24-bit RGB color')
  if (config.reconnectDelayMs > config.maxReconnectDelayMs) {
    throw new Error('discord-gateway: reconnectDelayMs must not exceed maxReconnectDelayMs')
  }
  if (config.outboxRetryMs > config.outboxMaxRetryMs) {
    throw new Error('discord-gateway: outboxRetryMs must not exceed outboxMaxRetryMs')
  }
  assertPresetCommands('excludedPresetCommands', config.excludedPresetCommands)
  if (config.answerers.length === 0) {
    throw new Error('discord-gateway: answerers must name at least one reply form; prompts nobody can answer only expire')
  }
  for (const form of config.answerers) {
    if (form !== 'reaction' && form !== 'text' && form !== 'component') {
      throw new Error(`discord-gateway: answerers entries must each be "reaction", "text", or "component", got "${form}"`)
    }
  }
  if (config.idleReleaseMs >= config.conversationMaxAgeMs) {
    throw new Error('discord-gateway: idleReleaseMs must be shorter than conversationMaxAgeMs, '
      + 'otherwise no conversation is ever resumed as an idle one before it expires')
  }
}

/** Reject an explicit filter that names neither list, instead of failing every conversation it would open. */
function assertToolFilter(field: string, filter: LaneToolFilter | undefined): void {
  if (filter !== undefined && filter.allow === undefined && filter.deny === undefined) {
    throw new Error(`discord-gateway: ${field} is configured but names neither \`allow\` nor \`deny\` — remove the key or fill the filter`)
  }
}

/** Exclusions name preset commands; the gateway's own controls stay available in every lane. */
function assertPresetCommands(field: string, commands: readonly string[]): void {
  for (const command of commands) {
    if (!/^[a-z][a-z0-9_-]*$/.test(command) || ['help', 'new', 'status', 'stop'].includes(command)) {
      throw new Error(`discord-gateway: ${field} must name preset commands, not gateway controls`)
    }
  }
}

/** Copy a configured filter without keys Schemastery left undefined; undefined stays undefined. */
function laneToolFilter(filter: LaneToolFilter | undefined): LaneToolFilter | undefined {
  if (filter === undefined) return undefined
  return { ...filter.allow === undefined ? {} : { allow: filter.allow }, ...filter.deny === undefined ? {} : { deny: filter.deny } }
}

/**
 * Split validated configuration into the settings and policy the router reads.
 * @param config - Complete validated plugin configuration.
 * @param botUserId - Current gateway bot identity used to match mentions.
 * @returns deployment settings and message admission policy.
 */
export function toSettings(
  config: ResolvedConfig,
  botUserId: () => string,
): { settings: GatewaySettings; policy: RoutingPolicy } {
  const defaultFilter = laneToolFilter(config.toolFilter)
  const userLanes = new Map<string, ConversationLane>(Object.entries(config.userLanes).map(([userId, lane]) => {
    const toolFilter = laneToolFilter(lane.toolFilter)
    return [userId, {
      userId,
      workspacePath: lane.workspacePath,
      agentPreset: lane.agentPreset,
      permissionPreset: lane.permissionPreset,
      excludedPresetCommands: [...new Set([...config.excludedPresetCommands, ...lane.excludedPresetCommands])],
      ...toolFilter === undefined ? {} : { toolFilter },
    }]
  }))
  return {
    settings: {
      richMessages: config.richMessages,
      excludedPresetCommands: config.excludedPresetCommands,
      accentColor: config.accentColor,
      reactionStatus: config.reactionStatus,
      replyRequestTimeoutMs: config.replyRequestTimeoutMs,
      replyMaxRetries: config.replyMaxRetries,
      replyMaxRetryWaitMs: config.replyMaxRetryWaitMs,
      replyMaxChunksPerCall: config.replyMaxChunksPerCall,
      interactionMaxPending: config.interactionMaxPending,
      interactionReceiptLimit: config.interactionReceiptLimit,
      workspacePath: config.workspacePath,
      agentPreset: config.agentPreset,
      permissionPreset: config.permissionPreset,
      ...defaultFilter === undefined ? {} : { toolFilter: defaultFilter },
      userLanes,
      titlePrefix: config.titlePrefix,
      maxInputChars: config.maxInputChars,
      turnTimeoutMs: config.turnTimeoutMs,
      idleReleaseMs: config.idleReleaseMs,
      conversationMaxAgeMs: config.conversationMaxAgeMs,
      inboundDebounceMs: config.inboundDebounceMs,
      guildRequireMention: config.guildRequireMention,
      typingIndicator: config.typingIndicator,
      approvalTimeoutMs: config.approvalTimeoutMs,
      questionTimeoutMs: config.questionTimeoutMs,
      answerers: config.answerers as GatewaySettings['answerers'],
      outboxMaxPending: config.outboxMaxPending,
      outboxMaxChars: config.outboxMaxChars,
      outboxRetryMs: config.outboxRetryMs,
      outboxMaxRetryMs: config.outboxMaxRetryMs,
      outboxMaxReceipts: config.outboxMaxReceipts,
      wakeRetryMs: config.wakeRetryMs,
    },
    policy: {
      allowedUserIds: new Set(config.allowedUserIds),
      allowedChannelIds: new Set(config.allowedChannelIds),
      guildRequireMention: config.guildRequireMention,
      botUserId,
      laneUserIds: new Set(userLanes.keys()),
    },
  }
}

/**
 * Resolve the bot token from the configured credential reference.
 *
 * @param ctx - context carrying the credential provider.
 * @param tokenEnv - credential reference naming the environment variable holding the token.
 * @returns the token value.
 * @throws when no credential is configured under that name.
 */
export async function resolveBotToken(ctx: Context, tokenEnv: string): Promise<string> {
  const credential = await ctx.credentials.resolve(credentialRef(tokenEnv))
  if (credential === undefined) {
    throw new Error(`discord-gateway: no bot token is configured for "${tokenEnv}". `
      + 'Set it in the environment or the root .env file.')
  }
  return credential.value
}

/** Seam for the gateway connection itself, so a composition test never dials out. */
export type GatewayConnector = (options: DiscordGatewayOptions, signal: AbortSignal) => Promise<void>

/**
 * Resolve the token and run the listener until `signal` aborts.
 *
 * A missing credential or an unknown preset is reported once, loudly, and the listener stays off:
 * retrying either would loop without new information.
 *
 * @param ctx - context carrying the credential provider.
 * @param config - complete plugin configuration.
 * @param router - conversation router fed by the gateway's messages.
 * @param signal - cancellation owned by the plugin's registration.
 * @param connect - connection seam, defaulting to the real Gateway client.
 * @param onReady - receives the bot's own user id from every `READY` dispatch.
 */
export async function startListener(
  ctx: Context,
  config: ResolvedConfig,
  router: ConversationRouter,
  signal: AbortSignal,
  connect: GatewayConnector = connectDiscordGateway,
  onReady?: (botUserId: string) => void,
): Promise<void> {
  const stopping = new AbortController()
  const active = AbortSignal.any([signal, stopping.signal])
  const aborted = (): boolean => active.aborted
  let native: ReturnType<typeof createNativeInteractions> | undefined
  let syncing: Promise<void> | undefined
  let removeObserver: (() => unknown) | undefined
  try {
    const credential = await resolveBotToken(ctx, config.tokenEnv)
    for (const lane of [config, ...Object.values(config.userLanes)]) {
      await ctx.agentPresets.resolve(lane.agentPreset)
      ctx.permissionPresets.resolve(lane.permissionPreset)
    }
    await using scopes = await resolvePresetScopes(ctx, config)
    let applicationId = ''
    const currentApplicationId = (): string => applicationId
    let synchronized = ''
    let requestSync = (): void => {}
    if (config.nativeCommands || config.richMessages || config.answerers.includes('component')) {
      const catalog = laneCommandCatalog(ctx, scopes)
      const { settings, policy } = toSettings(config, currentApplicationId)
      const defaultLane: ConversationLane = {
        workspacePath: settings.workspacePath, agentPreset: settings.agentPreset,
        permissionPreset: settings.permissionPreset, excludedPresetCommands: settings.excludedPresetCommands,
      }
      const actorCommands = (actor: DiscordCommandActor): readonly CommandDescriptor[] =>
        catalog((actor.directMessage ? settings.userLanes.get(actor.userId) : undefined) ?? defaultLane)
      const commands = (): readonly CommandDescriptor[] => {
        const names = new Set<string>()
        return [defaultLane, ...settings.userLanes.values()].flatMap(lane => catalog(lane))
          .filter((command) => {
            if (names.has(command.name)) return false
            names.add(command.name)
            return true
          })
      }
      native = createNativeInteractions({ signal: active, settings, policy, applicationId: currentApplicationId,
        commands: actorCommands, execute: (channelId, actor, line, requestSignal) => router.execute(channelId, actor, line, requestSignal),
        component: (interaction, requestSignal) => router.component(interaction, requestSignal),
        warn: (message) => { ctx.logger.warn(message) },
      })
      let requested = false
      const sync = async (): Promise<void> => {
        while (requested && !active.aborted) {
          requested = false
          try {
            const desired = buildDiscordCommandCatalog(commands())
            const signature = JSON.stringify(desired)
            if (signature === synchronized) continue
            await synchronizeDiscordCommands(applicationId, credential, commands(), active, {
              requestTimeoutMs: config.replyRequestTimeoutMs, maxRetries: config.replyMaxRetries,
              maxRetryWaitMs: config.replyMaxRetryWaitMs,
            })
            synchronized = signature
          } catch (error: unknown) {
            if (aborted()) break
            ctx.logger.warn(`discord-gateway: native command sync failed; retrying: ${errorChain(error)}`)
            requested = true
            try { await sleep(config.commandSyncRetryMs, active) } catch { break }
          }
        }
        syncing = undefined
      }
      requestSync = (): void => {
        if (!config.nativeCommands || applicationId === '' || active.aborted) return
        requested = true
        if (syncing !== undefined) return
        // Assign the in-flight promise before a catalog pass that may finish without awaiting.
        syncing = Promise.resolve().then(sync)
      }
      if (config.nativeCommands) removeObserver = ctx.on('commands/change', requestSync)
    }
    await connect({
      token: credential,
      intents: DISCORD_GATEWAY_INTENTS,
      onMessage: (message) => { router.handle(message) },
      onReaction: (reaction) => { router.handleReaction(reaction) },
      onInteraction: (interaction) => { native?.handle(interaction) },
      onReady: (botId, appId) => { applicationId = appId; synchronized = ''; onReady?.(botId); requestSync() },
      onStatus: (status) => {
        if (status.kind === 'ready') ctx.logger.info('discord-gateway: connected; messages from allowed users start conversations')
        else if (status.kind === 'disconnected') ctx.logger.warn(`discord-gateway: ${status.reason}; reconnecting`)
      },
      reconnectDelayMs: config.reconnectDelayMs, maxReconnectDelayMs: config.maxReconnectDelayMs,
    }, active)
  } catch (error: unknown) {
    if (!signal.aborted) ctx.logger.error(`discord-gateway: listener stopped and will not retry: ${errorChain(error)}`)
  } finally {
    stopping.abort()
    removeObserver?.()
    await Promise.allSettled([syncing, native?.dispose()])
  }
}

/** Standing scope of one agent preset, where that preset's commands register. */
export type PresetScope = Awaited<ReturnType<Context['agentPresets']['acquireScope']>>['key']

/** Preset command scopes retained for one reader's lifetime. */
export type PresetScopes = ReadonlyMap<string, PresetScope> & AsyncDisposable

/**
 * Resolve the standing scope of the default lane's preset and of every user lane's preset.
 * @param ctx - context carrying the agent preset roster.
 * @param config - complete validated plugin configuration.
 * @returns leased scopes keyed by preset id; the caller disposes the leases.
 */
export async function resolvePresetScopes(ctx: Context, config: ResolvedConfig): Promise<PresetScopes> {
  const scopes = new Map<string, PresetScope>()
  const leases: AsyncDisposable[] = []
  try {
    for (const preset of new Set([config.agentPreset, ...Object.values(config.userLanes).map(lane => lane.agentPreset)])) {
      const lease = await ctx.agentPresets.acquireScope(preset)
      leases.push(lease)
      scopes.set(preset, lease.key)
    }
  } catch (error: unknown) {
    await Promise.allSettled(leases.map(lease => lease[Symbol.asyncDispose]()))
    throw error
  }
  return Object.assign(scopes, { [Symbol.asyncDispose]: async () => {
    await Promise.all(leases.map(lease => lease[Symbol.asyncDispose]()))
  } })
}

/**
 * Read one lane's command catalog: its preset's commands minus that lane's exclusions.
 * @param ctx - context carrying the command registry.
 * @param scopes - standing scopes from {@link resolvePresetScopes}, covering every configured lane.
 * @returns the reader the router uses while a lane's channel has no live conversation.
 */
export function laneCommandCatalog(
  ctx: Context, scopes: ReadonlyMap<string, PresetScope>,
): (lane: ConversationLane) => readonly CommandDescriptor[] {
  return (lane) => {
    const scope = scopes.get(lane.agentPreset)
    if (scope === undefined) throw new Error(`discord-gateway: preset "${lane.agentPreset}" of a lane has no resolved standing scope`)
    return discordCommands(ctx.commands.listForScope(scope), lane.excludedPresetCommands)
  }
}

/**
 * Format bounded Host health facts for the gateway's human status reply.
 * @param status - optional health owner from the current Host composition.
 * @returns probe and cron-failure lines, or none without that owner.
 */
export function healthStatusLines(status: HealthStatus | undefined): string[] {
  const snapshot = status?.snapshot()
  if (snapshot === undefined) return []
  const probes = snapshot.probes.length === 0 ? 'Probes: none configured.'
    : `Probes: ${snapshot.probes.map(probe => `${probe.name} ${probe.state}${probe.cause === undefined ? '' : ` (${probe.cause})`}`).join(', ')}`
  const failure = snapshot.lastCronFailure
  return [probes, failure === undefined ? 'Last cron failure: none.'
    : `Last cron failure: ${failure.jobName}, Session ${failure.sessionId}, ${failure.code}, next ${failure.nextFireAt ?? 'none'}.`]
}

/**
 * Read current host health when a gateway status command is answered.
 * @param ctx - Host context carrying the current health service.
 * @returns Lines appended to the status command.
 */
export function currentHealthStatusLines(ctx: Context): string[] {
  return healthStatusLines(ctx.get('healthStatus'))
}

/**
 * Mount the Discord listener: validate configuration, open the durable conversation records, own
 * one cancellation for the connection, and dispose the gateway socket and every live conversation
 * Session when the fiber goes away. Durable records survive; only live handles are released.
 * @param ctx - registrant context carrying Session-creating services, the command registry, and the credential provider.
 * @param config - deployment's token reference, allowlists, workspace, presets, and conversation bounds.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = config as ResolvedConfig
  assertConfig(resolved)
  if (!resolved.enabled) {
    ctx.logger.info('discord-gateway: mounted but disabled by configuration')
    return
  }
  const scopes = await resolvePresetScopes(ctx, resolved)
  ctx.effect(() => async () => { await scopes[Symbol.asyncDispose]() }, 'discord-gateway preset scopes')
  const catalog = laneCommandCatalog(ctx, scopes)
  const domain = await ctx.storageDomain.open(discordGatewayDomainSpec)
  const controller = new AbortController()
  let botUserId = ''
  const { settings: configuredSettings, policy } = toSettings(resolved, () => botUserId)
  const settings: GatewaySettings = {
    ...configuredSettings, ...resolved.modelSelection === undefined ? {} : { modelSelection: resolved.modelSelection },
  }
  const router = createConversationRouter({
    ctx,
    signal: controller.signal,
    settings,
    policy,
    table: domain.table('conversations'),
    outboxTable: domain.table('outbox'),
    resolveToken: () => resolveBotToken(ctx, resolved.tokenEnv),
    commands: catalog,
    statusDetails: currentHealthStatusLines.bind(undefined, ctx),
  })
  attachCronDelivery(ctx, router)
  ctx.on('health/transition', async (transition): Promise<true> => {
    await router.deliver(transition.channelId, transition.text, transition.id)
    return true
  })

  ctx.effect(() => {
    const listening = router.recover().then(() => startListener(
      ctx,
      resolved,
      router,
      controller.signal,
      connectDiscordGateway,
      (applicationId: string) => { botUserId = applicationId },
    ))
    return async () => {
      controller.abort(new Error('discord-gateway disposed'))
      const disposed = router.dispose()
      await Promise.allSettled([listening, disposed])
      await disposed
      await domain.close()
    }
  }, 'discord-gateway listener')
}

/** Re-exported so a composition can substitute the socket without patching module internals. */
export type { GatewaySocketFactory }
