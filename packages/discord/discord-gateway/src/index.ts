/**
 * Model-facing Discord listener: direct messages from allowed users become Agent Sessions, and the
 * agent's answer is posted back to the channel they wrote in. The Gateway websocket, the allowlists,
 * and the presets are deployment configuration; a caller in Discord cannot widen any of them.
 * @module @deepseek-ai/dsh-discord-gateway
 */

import type { Context } from '@deepseek-ai/cordis'
import { isAbsolute } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { errorChain } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { createConversationRouter } from './conversation.ts'
import type { ConversationRouter, RoutingPolicy } from './conversation.ts'
import { connectDiscordGateway, DISCORD_GATEWAY_INTENTS } from './gateway.ts'
import type { DiscordGatewayOptions, GatewaySocketFactory } from './gateway.ts'
import type { GatewaySettings } from './types.ts'

export * from './conversation.ts'
export * from './gateway.ts'
export type * from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'discord-gateway'

/** Services the listener creates Sessions through. */
export const inject = [
  'agentDefaultModel',
  'agentPresets',
  'agents',
  'credentials',
  'permissionPresets',
  'sessionTitle',
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

/** Plugin configuration. Destinations, identity, and presets are never model input. */
export interface Config {
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
  /** Connect at mount. Set false to mount the plugin without dialing out. Defaults to true. */
  readonly enabled?: boolean
}

export const Config: z<Config> = z.object({
  tokenEnv: z.string().role('credential-ref').required(),
  allowedUserIds: z.array(z.string()).required(),
  allowedChannelIds: z.array(z.string()).default([]),
  workspacePath: z.string().required(),
  agentPreset: z.string().required(),
  permissionPreset: z.string().required(),
  titlePrefix: z.string().default('Discord'),
  maxInputChars: z.number().min(200).default(DEFAULT_DISCORD_MAX_INPUT_CHARS),
  turnTimeoutMs: z.number().min(1_000).default(DEFAULT_DISCORD_TURN_TIMEOUT_MS),
  reconnectDelayMs: z.number().min(1).default(DEFAULT_DISCORD_RECONNECT_DELAY_MS),
  maxReconnectDelayMs: z.number().min(1).default(DEFAULT_DISCORD_MAX_RECONNECT_DELAY_MS),
  enabled: z.boolean().default(true),
})

/** Complete configuration after schemastery applies every field default. */
export type ResolvedConfig = Required<Config>

/** A Discord user or channel id is a snowflake: 17 to 20 decimal digits. */
const SNOWFLAKE_PATTERN = /^\d{17,20}$/

/** Reject configuration that would listen for nobody, write outside a workspace, or wait unboundedly. */
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
  for (const [field, value] of Object.entries(config)) {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`discord-gateway: ${field} must be a positive safe integer`)
    }
  }
  if (config.reconnectDelayMs > config.maxReconnectDelayMs) {
    throw new Error('discord-gateway: reconnectDelayMs must not exceed maxReconnectDelayMs')
  }
}

/** Split validated configuration into the settings and policy the router reads. */
export function toSettings(config: ResolvedConfig): { settings: GatewaySettings; policy: RoutingPolicy } {
  return {
    settings: {
      workspacePath: config.workspacePath,
      agentPreset: config.agentPreset,
      permissionPreset: config.permissionPreset,
      titlePrefix: config.titlePrefix,
      maxInputChars: config.maxInputChars,
      turnTimeoutMs: config.turnTimeoutMs,
    },
    policy: {
      allowedUserIds: new Set(config.allowedUserIds),
      allowedChannelIds: new Set(config.allowedChannelIds),
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
 */
export async function startListener(
  ctx: Context,
  config: ResolvedConfig,
  router: ConversationRouter,
  signal: AbortSignal,
  connect: GatewayConnector = connectDiscordGateway,
): Promise<void> {
  try {
    const credential = await resolveBotToken(ctx, config.tokenEnv)
    await ctx.agentPresets.resolve(config.agentPreset)
    ctx.permissionPresets.resolve(config.permissionPreset)
    await connect({
      token: credential,
      intents: DISCORD_GATEWAY_INTENTS,
      onMessage: (message) => { router.handle(message) },
      onStatus: (status) => {
        if (status.kind === 'ready') {
          ctx.logger.info('discord-gateway: connected; messages from allowed users start conversations')
        } else if (status.kind === 'disconnected') {
          ctx.logger.warn(`discord-gateway: ${status.reason}; reconnecting`)
        }
      },
      reconnectDelayMs: config.reconnectDelayMs,
      maxReconnectDelayMs: config.maxReconnectDelayMs,
    }, signal)
  } catch (error: unknown) {
    if (signal.aborted) return
    ctx.logger.error(`discord-gateway: listener stopped and will not retry: ${errorChain(error)}`)
  }
}

/**
 * Mount the Discord listener: validate configuration, own one cancellation for the connection, and
 * dispose the gateway socket and every conversation Session when the fiber goes away.
 * @param ctx - registrant context carrying Session-creating services and the credential provider.
 * @param config - deployment's token reference, allowlists, workspace, and presets.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertConfig(resolved)
  if (!resolved.enabled) {
    ctx.logger.info('discord-gateway: mounted but disabled by configuration')
    return
  }
  const controller = new AbortController()
  const { settings, policy } = toSettings(resolved)
  const router = createConversationRouter({
    ctx,
    signal: controller.signal,
    settings,
    policy,
    resolveToken: () => resolveBotToken(ctx, resolved.tokenEnv),
  })

  ctx.effect(() => {
    void startListener(ctx, resolved, router, controller.signal)
    return async () => {
      controller.abort(new Error('discord-gateway disposed'))
      await router.dispose()
    }
  }, 'discord-gateway listener')
}

/** Re-exported so a composition can substitute the socket without patching module internals. */
export type { GatewaySocketFactory }
