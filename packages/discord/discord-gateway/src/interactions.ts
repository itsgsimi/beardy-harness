/**
 * Discord application-command discovery and transient interaction responses over the REST API.
 * Interaction tokens authorize one response lifecycle and must never enter durable delivery records.
 * @module @deepseek-ai/dsh-discord-gateway/interactions
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import { deadline } from '@deepseek-ai/dsh-timeout'
import {
  DEFAULT_DISCORD_MAX_RETRIES,
  DEFAULT_DISCORD_MAX_RETRY_WAIT_MS,
  DEFAULT_DISCORD_REQUEST_TIMEOUT_MS,
  discordReplyMessage,
  discordReplyObject,
  discordRequest,
  sliceUnits,
} from '@deepseek-ai/dsh-tool-discord'
import type { DiscordMessageBody, DiscordPostReply } from '@deepseek-ai/dsh-tool-discord'

/** Discord's opaque identity for one native command, component, or autocomplete invocation. */
export type DiscordInteractionId = Branded<'DiscordInteractionId'>

/**
 * Brand an already validated Discord interaction snowflake.
 * @param id - Validated interaction id.
 * @returns the unchanged branded identity.
 */
export function DiscordInteractionId(id: string): DiscordInteractionId { return id as DiscordInteractionId }

interface InteractionIdentity {
  readonly id: DiscordInteractionId
  readonly applicationId: string
  readonly token: string
  readonly userId: string
  readonly channelId: string
  readonly guildId: string
}

/** Validated gateway interaction; the token remains private to its transient response lifecycle. */
export type DiscordInteraction = InteractionIdentity & (
  | { readonly kind: 'command'; readonly name: string; readonly arguments: string }
  | { readonly kind: 'autocomplete'; readonly name: string; readonly focused: string }
  | { readonly kind: 'component'; readonly messageId: string; readonly customId: string; readonly values: readonly string[] }
)

const SNOWFLAKE = /^\d{17,20}$/u
const COMMAND_NAME = /^[a-z][a-z0-9_-]{0,31}$/u

function compareNames(left: string, right: string): number { return Number(left > right) - Number(left < right) }

function commandDescription(text: string): string {
  const description = sliceUnits(text, 100)[0]
  if (description === undefined) throw new Error('discord: native command and argument descriptions must not be empty')
  return description
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function snowflake(value: unknown): value is string {
  return typeof value === 'string' && SNOWFLAKE.test(value)
}

/**
 * Parse native command, autocomplete, and component fields from a Discord dispatch.
 * @param payload - Untrusted INTERACTION_CREATE data received from Discord.
 * @returns the supported interaction, or undefined when identity or command fields are invalid.
 */
export function parseDiscordInteraction(payload: unknown): DiscordInteraction | undefined {
  const record = object(payload)
  if (record === undefined) return undefined
  if (record['context'] === 2) return undefined
  const guildId = record['guild_id'] ?? ''
  if (guildId !== '' && !snowflake(guildId)) return undefined
  const user = object(guildId === '' ? record['user'] : object(record['member'])?.['user'])
  const userId = user?.['id']
  const channelId = record['channel_id'] ?? object(record['channel'])?.['id']
  const id = record['id']
  const applicationId = record['application_id']
  const token = record['token']
  if (!snowflake(id) || !snowflake(applicationId) || !snowflake(channelId) || !snowflake(userId)
    || typeof token !== 'string' || token === '') return undefined
  const identity: InteractionIdentity = { id: DiscordInteractionId(id), applicationId, token, userId, channelId, guildId }
  const data = object(record['data'])
  if (data === undefined) return undefined
  if (record['type'] === 3) {
    const messageId = object(record['message'])?.['id']
    const customId = data['custom_id']
    const values = data['values'] ?? []
    if ((data['component_type'] !== 2 && data['component_type'] !== 3)
      || !snowflake(messageId) || typeof customId !== 'string' || customId.length === 0 || customId.length > 100
      || !Array.isArray(values) || values.length > 25 || values.some(value => typeof value !== 'string')) return undefined
    return { ...identity, kind: 'component', messageId, customId, values: values as string[] }
  }
  if (record['type'] !== 2 && record['type'] !== 4) return undefined
  const name = data['name']
  if (data['type'] !== 1 || typeof name !== 'string' || !COMMAND_NAME.test(name)) return undefined
  const options = data['options'] ?? []
  if (!Array.isArray(options) || options.length > 1) return undefined
  const option = options.length === 0 ? undefined : object(options[0])
  if (options.length !== 0 && (option === undefined || option['name'] !== 'arguments'
    || option['type'] !== 3 || typeof option['value'] !== 'string')) return undefined
  const value = option?.['value'] as string | undefined
  if (record['type'] === 4) {
    if (option?.['focused'] !== true || value === undefined) return undefined
    return { ...identity, kind: 'autocomplete', name, focused: value }
  }
  return { ...identity, kind: 'command', name, arguments: value ?? '' }
}

/** One completion choice returned to Discord's native autocomplete popup. */
export interface DiscordAutocompleteChoice {
  /** Label shown in the native completion menu. */
  readonly name: string
  /** Argument text supplied when the choice is selected. */
  readonly value: string
}

/** Initial response fields for messages, component updates, or autocomplete suggestions. */
export type DiscordInteractionReplyData = Partial<DiscordMessageBody> & {
  /** Discord response flags, including 64 for an ephemeral response. */
  readonly flags?: number
  /** Up to 25 suggestions for an autocomplete response. */
  readonly choices?: readonly DiscordAutocompleteChoice[]
}

/** Transient interaction response transport; no operation persists the bearer token. */
export interface DiscordInteractionTransport {
  /**
   * Send the sole initial callback within Discord's acknowledgement deadline.
   * @param interaction - Validated invocation containing its transient response token.
   * @param type - Discord callback type appropriate to this interaction.
   * @param data - Message fields or autocomplete choices; absent for an empty acknowledgement.
   * @param signal - Listener cancellation.
   * @returns after Discord accepts the callback.
   */
  reply(interaction: DiscordInteraction, type: 4 | 5 | 6 | 7 | 8,
    data: DiscordInteractionReplyData | undefined, signal: AbortSignal): Promise<void>
  /**
   * Replace the original response after an acknowledgement.
   * @param interaction - Invocation whose response is edited.
   * @param body - Bounded replacement message fields.
   * @param signal - Listener cancellation.
   * @returns after Discord accepts the edit.
   */
  edit(interaction: DiscordInteraction, body: DiscordMessageBody, signal: AbortSignal): Promise<void>
  /**
   * Post a private further response during the interaction token's lifetime.
   * @param interaction - Invocation whose response is continued.
   * @param body - Bounded additional message fields.
   * @param signal - Listener cancellation.
   * @returns after Discord accepts the message.
   */
  followup(interaction: DiscordInteraction, body: DiscordMessageBody, signal: AbortSignal): Promise<void>
}

/** REST timeout and request seam for an interaction response transport. */
export interface DiscordInteractionTransportOptions {
  /** Maximum duration of an individual REST request. */
  readonly requestTimeoutMs: number
  /** Discord REST implementation, replaceable without process-global interception. */
  readonly request?: typeof discordRequest
}

/** Discord's published initial interaction-response deadline in milliseconds. */
export const DISCORD_INTERACTION_ACK_TIMEOUT_MS = 3_000

function assertReply(reply: DiscordPostReply, operation: string): void {
  if (reply.status >= 200 && reply.status < 300) return
  const detail = discordReplyMessage(reply)
  throw new Error(`discord: ${operation} failed (HTTP ${String(reply.status)}${detail === undefined ? '' : `: ${detail}`})`)
}

/**
 * Create a response transport that never exposes interaction-token URLs in failures.
 * @param options - Deployment request timeout and optional isolated request implementation.
 * @returns a transport whose requests omit bot authorization and suppress mentions on every edit.
 */
export function createDiscordInteractionTransport(options: DiscordInteractionTransportOptions): DiscordInteractionTransport {
  const request = options.request ?? discordRequest
  const send = async (method: 'POST' | 'PATCH', path: string, body: unknown, signal: AbortSignal,
    timeoutMs: number, operation: string): Promise<void> => {
    using timeout = deadline(signal, timeoutMs, 'DISCORD_INTERACTION_TIMEOUT')
    let reply: DiscordPostReply
    try {
      reply = await request({ method, path, body }, timeout.signal)
    } catch {
      // Request exceptions may contain the bearer-token URL; expose only the operation and cancellation.
      if (signal.aborted) throw new Error(`discord: ${operation} cancelled`)
      throw new Error(`discord: ${operation} request failed`)
    }
    if (reply.status < 200 || reply.status >= 300) {
      throw new Error(`discord: ${operation} failed (HTTP ${String(reply.status)})`)
    }
  }
  const message = (body: DiscordInteractionReplyData) => ({ ...body, allowed_mentions: { parse: [] } })
  const webhook = (interaction: DiscordInteraction) =>
    `/webhooks/${encodeURIComponent(interaction.applicationId)}/${encodeURIComponent(interaction.token)}`
  return {
    reply: async (interaction, type, data, signal) => {
      await send('POST', `/interactions/${encodeURIComponent(interaction.id)}/${encodeURIComponent(interaction.token)}/callback`,
        { type, ...(data === undefined ? {} : { data: type === 4 || type === 7 ? message(data) : data }) },
        signal, Math.min(options.requestTimeoutMs, DISCORD_INTERACTION_ACK_TIMEOUT_MS), 'interaction acknowledgement')
    },
    edit: async (interaction, body, signal) => {
      await send('PATCH', `${webhook(interaction)}/messages/@original`, message(body), signal,
        options.requestTimeoutMs, 'interaction response edit')
    },
    followup: async (interaction, body, signal) => {
      await send('POST', webhook(interaction), message({ ...body, flags: 64 }), signal, options.requestTimeoutMs, 'interaction followup')
    },
  }
}

/** Discord REST transport with the sender's default request timeout. */
export const productionInteractionTransport = createDiscordInteractionTransport({
  requestTimeoutMs: DEFAULT_DISCORD_REQUEST_TIMEOUT_MS,
})

/** Canonical Discord application-command payload derived from a registry descriptor. */
export interface DiscordApplicationCommand {
  /** Discord chat-input command type. */
  readonly type: 1
  /** Native name without a leading slash. */
  readonly name: string
  /** Native menu description, bounded to Discord's limit. */
  readonly description: string
  /** Restrict commands to guilds and DMs with this bot. */
  readonly contexts: readonly [0, 1]
  /** DSH authorizes callers itself; stale command restrictions and translations are cleared. */
  readonly default_member_permissions: null
  readonly nsfw: false
  readonly name_localizations: null
  readonly description_localizations: null
  /** The optional unstructured input advertised by DSH's command descriptor. */
  readonly options: readonly {
    readonly type: 3
    readonly name: 'arguments'
    readonly description: string
    readonly required: false
    readonly name_localizations: null
    readonly description_localizations: null
  }[]
}

/**
 * Project current DSH command metadata into native guild and bot-DM commands.
 * @param commands - Effective descriptors of the configured preset and gateway commands.
 * @returns a name-sorted catalog with Discord-bounded descriptions and optional unstructured arguments.
 * @throws when command metadata cannot be represented, names repeat, or the catalog exceeds Discord's limit.
 */
export function buildDiscordCommandCatalog(commands: readonly CommandDescriptor[]): DiscordApplicationCommand[] {
  if (commands.length > 100) throw new Error('discord: the global catalog cannot contain more than 100 chat-input commands')
  const names = new Set<string>()
  return commands.map((command): DiscordApplicationCommand => {
    if (!COMMAND_NAME.test(command.name)) throw new Error(`discord: command name "${command.name}" must contain 1 to 32 lowercase command characters`)
    if (names.has(command.name)) throw new Error(`discord: duplicate command "${command.name}" in the application catalog`)
    names.add(command.name)
    return {
      type: 1, name: command.name, description: commandDescription(command.description), contexts: [0, 1],
      default_member_permissions: null, nsfw: false, name_localizations: null, description_localizations: null,
      options: command.input === undefined ? [] : [{
        type: 3, name: 'arguments', description: commandDescription(command.input.hint), required: false,
        name_localizations: null, description_localizations: null,
      }],
    }
  }).sort((left, right) => compareNames(left.name, right.name))
}

/** Bounds and external seams for a command-catalog reconciliation. */
export interface DiscordCommandSyncOptions {
  /** Maximum duration of one REST attempt. */
  readonly requestTimeoutMs: number
  /** Additional attempts after a rate-limited response. */
  readonly maxRetries: number
  /** Maximum server-requested wait accepted before a retry. */
  readonly maxRetryWaitMs: number
  /** Discord REST implementation, replaceable without process-global interception. */
  readonly request?: typeof discordRequest
  /** Cancellation-aware rate-limit delay implementation. */
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>
}

async function wait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); reject(new Error('discord: command synchronization cancelled')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

function sameCatalog(value: unknown, wanted: readonly DiscordApplicationCommand[]): boolean {
  if (!Array.isArray(value) || value.length !== wanted.length) return false
  const remote = value.map(object).sort((left, right) => compareNames(String(left?.['name']), String(right?.['name'])))
  return wanted.every((command, index) => {
    const entry = remote[index]
    if (entry === undefined || entry['type'] !== 1 || entry['name'] !== command.name
      || entry['description'] !== command.description) return false
    if (entry['default_member_permissions'] != null || entry['nsfw'] === true
      || entry['name_localizations'] != null || entry['description_localizations'] != null) return false
    const contexts = entry['contexts']
    if (!Array.isArray(contexts) || contexts.length !== 2 || !contexts.includes(0) || !contexts.includes(1)) return false
    const options = entry['options'] ?? []
    if (!Array.isArray(options) || options.length !== command.options.length) return false
    return command.options.every((option, position) => {
      const actual = object(options[position])
      return actual?.['type'] === option.type && actual['name'] === option.name
        && actual['description'] === option.description && (actual['required'] ?? false) === false
        && actual['min_length'] === undefined && actual['max_length'] === undefined
        && actual['name_localizations'] == null && actual['description_localizations'] == null
        && (actual['autocomplete'] ?? false) === false && (actual['choices'] === undefined
          || Array.isArray(actual['choices']) && actual['choices'].length === 0)
    })
  })
}

/**
 * Reconcile the application's global command catalog after checking gateway interaction delivery.
 * @param applicationId - Bot application identity received from READY.
 * @param token - Bot credential used only for this reconciliation.
 * @param commands - Effective registry command descriptors to advertise.
 * @param signal - Cancellation of the owning listener.
 * @param options - Request/retry bounds and isolated external implementations.
 * @returns after the remote catalog matches, without writing when it already does.
 * @throws when webhook delivery is configured, Discord refuses a request, or rate-limit bounds expire.
 */
export async function synchronizeDiscordCommands(
  applicationId: string,
  token: string,
  commands: readonly CommandDescriptor[],
  signal: AbortSignal,
  options: DiscordCommandSyncOptions = {
    requestTimeoutMs: DEFAULT_DISCORD_REQUEST_TIMEOUT_MS,
    maxRetries: DEFAULT_DISCORD_MAX_RETRIES,
    maxRetryWaitMs: DEFAULT_DISCORD_MAX_RETRY_WAIT_MS,
  },
): Promise<void> {
  const catalog = buildDiscordCommandCatalog(commands)
  const request = options.request ?? discordRequest
  const pause = options.wait ?? wait
  const call = async (method: 'GET' | 'PUT', path: string, body?: unknown): Promise<DiscordPostReply> => {
    for (let attempt = 0; ; attempt += 1) {
      signal.throwIfAborted()
      let reply: DiscordPostReply
      {
        using timeout = deadline(signal, options.requestTimeoutMs, 'DISCORD_COMMAND_SYNC_TIMEOUT')
        reply = await request({ method, path, token, ...(body === undefined ? {} : { body }) }, timeout.signal)
      }
      if (reply.status !== 429 || attempt >= options.maxRetries) { assertReply(reply, 'command synchronization'); return reply }
      const seconds = discordReplyObject(reply.body)?.['retry_after']
      const retryMs = typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
        ? Math.ceil(seconds * 1000) : reply.retryAfterMs
      if (retryMs === undefined || retryMs > options.maxRetryWaitMs) throw new Error('discord: command synchronization rate limit exceeds the configured wait')
      await pause(retryMs, signal)
    }
  }
  const application = discordReplyObject((await call('GET', '/applications/@me')).body)
  if (application?.['id'] !== applicationId) throw new Error('discord: application metadata does not match the connected bot')
  if (application['interactions_endpoint_url'] !== undefined && application['interactions_endpoint_url'] !== null
    && application['interactions_endpoint_url'] !== '') {
    throw new Error('discord: clear the Interactions Endpoint URL in the Discord Developer Portal to receive native commands through this gateway')
  }
  const path = `/applications/${encodeURIComponent(applicationId)}/commands`
  const response = await call('GET', path)
  let current: unknown
  try { current = JSON.parse(response.body) as unknown } catch { throw new Error('discord: command catalog response is not JSON') }
  if (!Array.isArray(current)) throw new Error('discord: command catalog response is not an array')
  if (!sameCatalog(current, catalog)) await call('PUT', path, catalog)
}
