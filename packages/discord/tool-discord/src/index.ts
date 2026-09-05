/**
 * Model-facing `discord_send` tool: one outbound message to one configured Discord channel. The
 * destination and the bot token are deployment configuration, never model input, so a caller can
 * compose content but cannot choose where it goes or which credentials post it.
 * @module @deepseek-ai/dsh-tool-discord
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DISCORD_MAX_CONTENT_CHARS } from './chunk.ts'
import { openDirectMessageChannel, postChannelMessage } from './http.ts'
import type { DiscordDmChannelOpener, DiscordMessagePoster } from './http.ts'
import { sendDiscordMessage } from './send.ts'

export * from './chunk.ts'
export * from './http.ts'
export * from './send.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-discord'

/** Services the tool resolves credentials through and registers on. */
export const inject = ['tools', 'credentials']

/** Default per-attempt request timeout (ms) for one Discord POST. */
export const DEFAULT_DISCORD_REQUEST_TIMEOUT_MS = 15_000

/** Default additional attempts after a 429 reply. */
export const DEFAULT_DISCORD_MAX_RETRIES = 2

/** Default longest server-requested delay the tool waits out (ms). */
export const DEFAULT_DISCORD_MAX_RETRY_WAIT_MS = 30_000

/** Default cap on messages posted by one call. */
export const DEFAULT_DISCORD_MAX_CHUNKS_PER_CALL = 10

/** Plugin configuration; every field is required so no destination or secret is defaulted. */
export interface Config {
  /** Credential reference holding the bot token, such as `DISCORD_BOT_TOKEN`. */
  readonly tokenEnv: string
  /** Target channel id. The model cannot select another destination. */
  readonly channelId: string
  /** User ids a direct message may open to. Empty leaves direct messaging off. Defaults to empty. */
  readonly dmUserIds?: string[]
  /** Per-attempt request timeout in milliseconds. Defaults to 15000. */
  readonly requestTimeoutMs?: number
  /** Additional attempts after a 429 reply; zero posts once. Defaults to 2. */
  readonly maxRetries?: number
  /** Longest `Retry-After` delay the tool waits out, in milliseconds. Defaults to 30000. */
  readonly maxRetryWaitMs?: number
  /** Maximum messages one call may post. Defaults to 10. */
  readonly maxChunksPerCall?: number
}

export const Config: z<Config> = z.object({
  tokenEnv: z.string().role('credential-ref').required(),
  channelId: z.string().required(),
  requestTimeoutMs: z.number().default(DEFAULT_DISCORD_REQUEST_TIMEOUT_MS),
  maxRetries: z.number().min(0).default(DEFAULT_DISCORD_MAX_RETRIES),
  maxRetryWaitMs: z.number().default(DEFAULT_DISCORD_MAX_RETRY_WAIT_MS),
  maxChunksPerCall: z.number().min(1).default(DEFAULT_DISCORD_MAX_CHUNKS_PER_CALL),
  dmUserIds: z.array(z.string()).default([]),
})

/** Complete configuration after schemastery applies every field default. */
export type ResolvedConfig = Required<Config>

/** A Discord channel id is a snowflake: 17 to 20 decimal digits. */
const CHANNEL_ID_PATTERN = /^\d{17,20}$/

/** Reject configuration that would post nowhere or wait unboundedly. */
function assertConfig(config: ResolvedConfig): void {
  if (!CHANNEL_ID_PATTERN.test(config.channelId)) {
    throw new Error('tool-discord: channelId must be a Discord snowflake of 17 to 20 digits')
  }
  for (const userId of config.dmUserIds) {
    if (!CHANNEL_ID_PATTERN.test(userId)) {
      throw new Error(`tool-discord: dmUserIds must each be a Discord snowflake of 17 to 20 digits, got "${userId}"`)
    }
  }
  for (const [field, value] of Object.entries(config)) {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`tool-discord: ${field} must be a non-negative safe integer`)
    }
  }
}

/** Wait out one rate-limit delay, rejecting immediately when the call is cancelled. */
function waitAborted(ms: number, signal: AbortSignal): Promise<void> {
  const cancellation = (): Error => signal.reason instanceof Error
    ? signal.reason
    : new Error('discord_send was cancelled', { cause: signal.reason })
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(cancellation())
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(cancellation())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Transport seams the sender uses; a test replaces them to run without a network or a real delay. */
export interface DiscordTransport {
  /** Performs one channel-message POST. */
  readonly post: DiscordMessagePoster
  /** Resolves the direct-message channel of one allowed recipient. */
  readonly openDm: DiscordDmChannelOpener
  /** Sleeps between attempts until cancelled. */
  readonly wait: (ms: number, signal: AbortSignal) => Promise<void>
}

/** Production transport: the Discord REST API and a real timer. */
export const productionTransport: DiscordTransport = {
  post: postChannelMessage,
  openDm: openDirectMessageChannel,
  wait: waitAborted,
}

/** Model-facing contract, written from the deployment's actual destinations. */
function toolDescription(config: ResolvedConfig): string {
  const direct = config.dmUserIds.length === 0
    ? 'The only destination is the configured channel.'
    : `You may instead send a direct message by naming one of these user ids in \`recipient\`: ${config.dmUserIds.join(', ')}.`
  return 'Post a message to Discord. Content is Discord Markdown. ' + direct
    + ' No other destination exists. One message holds '
    + `${String(DISCORD_MAX_CONTENT_CHARS)} characters, and longer content is split across `
    + 'consecutive messages on paragraph, line, and word boundaries, so prefer one message under '
    + 'that limit. No mention pings anyone: @everyone and @here are rewritten before sending and '
    + 'user or role mentions are inert.'
}

/**
 * Build the `discord_send` definition for one resolved configuration.
 * @param ctx - context carrying the credential provider used at call time.
 * @param config - complete plugin configuration.
 * @param transport - transport seams, defaulting to the Discord REST API.
 * @returns the tool definition to register on `ctx.tools`.
 */
export function createDiscordSendTool(
  ctx: Context,
  config: ResolvedConfig,
  transport: DiscordTransport = productionTransport,
) {
  const ref = credentialRef(config.tokenEnv)
  const allowedRecipients = new Set(config.dmUserIds)
  return defineTool({
    name: 'discord_send',
    description: toolDescription(config),
    parameters: {
      content: {
        type: 'string',
        required: true,
        description: 'Discord Markdown body to post. Non-empty; leading and trailing whitespace is trimmed.',
      },
      ...(allowedRecipients.size === 0 ? {} : {
        recipient: {
          type: 'string' as const,
          description: 'User id to message directly instead of posting to the configured channel.',
        },
      }),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          channelId: { type: 'string', required: true },
          chunks: { type: 'integer', required: true },
          characters: { type: 'integer', required: true },
          suppressedBroadcastMentions: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Posted ${String(value.chunks)} Discord message${value.chunks === 1 ? '' : 's'} to `
          + `channel ${value.channelId} (${String(value.characters)} characters)`
          + (value.suppressedBroadcastMentions === 0
            ? '.'
            : `, rewriting ${String(value.suppressedBroadcastMentions)} broadcast mention(s).`),
      }],
    },
    async execute(args, exec) {
      const recipient = 'recipient' in args ? args.recipient : undefined
      if (recipient !== undefined && !allowedRecipients.has(recipient)) {
        throw new Error(
          `discord_send: "${recipient}" is not an allowed direct-message recipient. Configure it `
          + 'in dmUserIds or post to the configured channel.',
        )
      }
      const credential = await ctx.credentials.resolve(ref)
      if (credential === undefined) {
        throw new Error(
          `discord_send: no bot token is configured for "${config.tokenEnv}". Set it in the `
          + 'environment or the root .env file.',
        )
      }
      const channel = recipient === undefined
        ? config.channelId
        : await transport.openDm({ recipientId: recipient, token: credential.value }, exec.signal)
      const result = await sendDiscordMessage({
        channel,
        post: transport.post,
        wait: transport.wait,
        requestTimeoutMs: config.requestTimeoutMs,
        maxRetries: config.maxRetries,
        maxRetryWaitMs: config.maxRetryWaitMs,
        maxChunksPerCall: config.maxChunksPerCall,
      }, credential.value, args.content, exec.signal)
      return { ...result, channelId: channel }
    },
    presentCall: args => ({ card: 'generic', title: 'Send Discord message', kind: 'other', rawInput: args.content }),
  })
}

/**
 * Register `discord_send` on `ctx.tools`. The registration is fiber-scoped, so disposing the plugin
 * removes the tool.
 * @param ctx - registrant context carrying the tool registry and credential provider.
 * @param config - deployment's channel, credential reference, and bounds.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertConfig(resolved)
  ctx.tools.register(createDiscordSendTool(ctx, resolved))
}
