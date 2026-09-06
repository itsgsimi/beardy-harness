/**
 * Discord REST transport for the bot's outbound calls: one channel message, and the direct-message
 * channel a user must be messaged through. The bot token reaches this module only as a resolved
 * argument; it is never logged, and a failure carries the status and Discord's own message rather
 * than any request header.
 * @module @deepseek-ai/dsh-tool-discord/http
 */

/** Base URL of the Discord REST API version this package targets. A published protocol constant. */
export const DISCORD_API_BASE = 'https://discord.com/api/v10'

/**
 * Cap on one response body read. It bounds both a successful message payload and an error report,
 * whose content is server-controlled.
 */
export const DISCORD_MAX_RESPONSE_BYTES = 8_192

/** One channel-message POST the transport performs. */
export interface DiscordPostRequest {
  /** Target channel id supplied by validated configuration, never by the model. */
  readonly channelId: string
  /** Bot token resolved from a credential reference for this operation only. */
  readonly token: string
  /** Complete `content` value of one message, already within the protocol limit. */
  readonly content: string
}

/** One API reply reduced to the facts the sender acts on. */
export interface DiscordPostReply {
  /** HTTP status code. */
  readonly status: number
  /** Server-requested delay in milliseconds, read from `Retry-After`; absent when not sent. */
  readonly retryAfterMs: number | undefined
  /** Response body decoded as UTF-8, bounded by {@link DISCORD_MAX_RESPONSE_BYTES}. */
  readonly body: string
}

/** Transport seam: the sender's retry policy is tested against a stub without a network. */
export type DiscordMessagePoster = (request: DiscordPostRequest, signal: AbortSignal) => Promise<DiscordPostReply>

/** Read a `Retry-After` header expressed in seconds, which may be fractional. */
function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds < 0) return undefined
  return Math.round(seconds * 1000)
}

/**
 * Read a response body under {@link DISCORD_MAX_RESPONSE_BYTES}.
 *
 * @param response - response whose stream is drained or abandoned.
 * @returns the decoded body, or an empty string when the response carries none.
 * @throws Error when the body exceeds the cap before it ends.
 */
async function readBoundedBody(response: Response): Promise<string> {
  if (response.body === null) return ''
  const pieces: Uint8Array[] = []
  let total = 0
  // Undici exposes response chunks as `any`; Fetch guarantees body chunks are Uint8Array.
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > DISCORD_MAX_RESPONSE_BYTES) {
        throw new Error(`discord: response body exceeded ${String(DISCORD_MAX_RESPONSE_BYTES)} bytes`)
      }
      pieces.push(value)
    }
  } finally {
    /* v8 ignore next 4 -- cancel() after a completed or broken read settles without rejecting; unobserved best-effort cleanup. */
    await reader.cancel().catch(() => {
      // The bytes needed are already collected, or the request failed for the caller to see.
    })
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const piece of pieces) {
    bytes.set(piece, offset)
    offset += piece.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/**
 * POST one bot-authenticated request and read its bounded reply.
 *
 * Redirects are refused before the request is sent again so the bot token cannot be forwarded to
 * another origin. The caller's signal cancels both the request and the body read.
 *
 * @param path - API path relative to {@link DISCORD_API_BASE}.
 * @param token - bot token resolved for this operation only.
 * @param payload - JSON body to send.
 * @param signal - cancellation for this single attempt.
 * @returns the status, any server-requested delay, and the bounded body.
 */
async function postBounded(
  path: string,
  token: string,
  payload: Record<string, unknown>,
  signal: AbortSignal,
): Promise<DiscordPostReply> {
  const response = await fetch(`${DISCORD_API_BASE}${path}`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      authorization: `Bot ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal,
  })
  const body = await readBoundedBody(response)
  return { status: response.status, retryAfterMs: parseRetryAfter(response.headers.get('retry-after')), body }
}

/** Longest slice of Discord's own error text carried into a failure message. */
const REPLY_MESSAGE_MAX_CHARS = 300

/**
 * The JSON object one reply body carries.
 *
 * @param body - bounded response body, possibly empty or not JSON.
 * @returns the parsed object, or undefined when the body is absent, malformed, or not an object.
 */
export function discordReplyObject(body: string): Record<string, unknown> | undefined {
  if (body === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch {
    // A non-JSON error page still carries the status; only its fields are unavailable.
    return undefined
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined
}

/**
 * Discord's own explanation of a call, read from the JSON `message` field and bounded, so
 * server-controlled text cannot dominate a failure message.
 *
 * @param reply - any reply from the API.
 * @returns the server's message text, or undefined when the body carries none.
 */
export function discordReplyMessage(reply: DiscordPostReply): string | undefined {
  const message = discordReplyObject(reply.body)?.['message']
  return typeof message === 'string' && message !== ''
    ? message.slice(0, REPLY_MESSAGE_MAX_CHARS)
    : undefined
}

/**
 * POST one message to one Discord channel.
 *
 * @param request - target channel, resolved token, and bounded content.
 * @param signal - cancellation for this single attempt.
 * @returns the status, any server-requested delay, and the bounded body.
 */
export const postChannelMessage: DiscordMessagePoster = (request, signal) => postBounded(
  `/channels/${request.channelId}/messages`,
  request.token,
  // `parse: []` disables every mention form, so a mention token planted in fetched content
  // cannot ping the channel regardless of what the model composed.
  { content: request.content, allowed_mentions: { parse: [] } },
  signal,
)

/** Request for the direct-message channel that carries messages to one user. */
export interface DiscordOpenDmRequest {
  /** User id the bot opens a direct-message channel with. */
  readonly recipientId: string
  /** Bot token resolved from a credential reference for this operation only. */
  readonly token: string
}

/** Transport seam: opening a direct-message channel, stubbed in tests. */
export type DiscordDmChannelOpener = (request: DiscordOpenDmRequest, signal: AbortSignal) => Promise<string>

/**
 * Open — or reuse — the direct-message channel to one user and return its channel id.
 *
 * Discord reuses the existing channel for a recipient, so repeated calls add no state on this side.
 * A refusal or a reply without a usable channel id is an error carrying Discord's own message:
 * messaging a user the bot cannot reach must not read as success.
 *
 * @param request - recipient and resolved token.
 * @param signal - cancellation for this single attempt.
 * @returns the direct-message channel id to post into.
 * @throws Error when the API refuses the channel or answers without one.
 */
export const openDirectMessageChannel: DiscordDmChannelOpener = async (request, signal) => {
  const reply = await postBounded('/users/@me/channels', request.token, { recipient_id: request.recipientId }, signal)
  const detail = discordReplyMessage(reply)
  if (reply.status < 200 || reply.status >= 300) {
    throw new Error(`discord: cannot open a direct message to ${request.recipientId} `
      + `(HTTP ${String(reply.status)}${detail === undefined ? '' : `: ${detail}`})`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(reply.body) as unknown
  } catch {
    parsed = undefined
  }
  const channelId = typeof parsed === 'object' && parsed !== null
    ? (parsed as { id?: unknown }).id
    : undefined
  if (typeof channelId !== 'string' || channelId === '') {
    throw new Error(`discord: opening a direct message to ${request.recipientId} returned no channel id`)
  }
  return channelId
}

/**
 * Tell Discord the bot is typing in one channel. The indicator expires on Discord's side after
 * about ten seconds, so a long-running turn repeats this call rather than sending one.
 *
 * @param channelId - channel to show the typing indicator in.
 * @param token - bot token resolved for this operation only.
 * @param signal - cancellation for this single attempt.
 * @returns resolution once the request completes; the reply status is not inspected, because a
 * missed indicator must never fail the turn it decorates.
 */
export async function postTyping(channelId: string, token: string, signal: AbortSignal): Promise<void> {
  await postBounded(`/channels/${channelId}/typing`, token, {}, signal)
}
