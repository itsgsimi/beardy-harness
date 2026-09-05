/**
 * Delivery of one message body to the configured Discord channel: broadcast-mention defanging,
 * chunking, per-attempt timeout, and bounded rate-limit retry.
 * @module @deepseek-ai/dsh-tool-discord/send
 */

import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { chunkContent } from './chunk.ts'
import { discordReplyMessage, discordReplyObject } from './http.ts'
import type { DiscordMessagePoster, DiscordPostReply } from './http.ts'

/** Timeout code stamped on the per-attempt deadline. */
const TIMEOUT_CODE = 'DISCORD_TIMEOUT'

/** `@everyone` and `@here`, rewritten wherever they appear. */
const BROADCAST_MENTION_PATTERN = /@(everyone|here)/g

/** '@' followed by a zero-width space: readable, and inert as a mention token. */
const INERT_AT = '@\u200b'

/** Bounds the sender applies to one call. Every value comes from validated plugin configuration. */
export interface DiscordSendLimits {
  /** Per-attempt request timeout in milliseconds. */
  readonly requestTimeoutMs: number
  /** Additional attempts allowed after a 429 reply. Zero disables retrying. */
  readonly maxRetries: number
  /** Longest server-requested delay the sender will wait out. */
  readonly maxRetryWaitMs: number
  /** Maximum messages one call may post. */
  readonly maxChunksPerCall: number
}

/** Everything the sender needs, including the two seams tests replace. */
export interface DiscordSenderOptions extends DiscordSendLimits {
  /** Target channel id from validated configuration. */
  readonly channel: string
  /** Transport performing one POST. */
  readonly post: DiscordMessagePoster
  /** Delay used between attempts; aborts with the caller's signal. */
  readonly wait: (ms: number, signal: AbortSignal) => Promise<void>
}

/** Canonical result of one successful call. */
export interface DiscordSendResult {
  /** Messages posted in order. */
  readonly chunks: number
  /** Total UTF-16 units sent across every message body. */
  readonly characters: number
  /** Count of `@everyone` and `@here` tokens rewritten before sending. */
  readonly suppressedBroadcastMentions: number
}

/**
 * Rewrite broadcast mentions so no message can ping an entire channel.
 *
 * @param content - model-composed body, which may quote fetched content containing a mention token.
 * @returns the rewritten body and how many tokens were rewritten.
 */
export function defangBroadcastMentions(content: string): { content: string; count: number } {
  let count = 0
  const rewritten = content.replace(BROADCAST_MENTION_PATTERN, (_match, word: string) => {
    count += 1
    return INERT_AT + word
  })
  return { content: rewritten, count }
}

/** Read the delay a 429 reply asks for, preferring the JSON field over the header. */
function retryDelayMs(reply: DiscordPostReply): number | undefined {
  const declared: unknown = discordReplyObject(reply.body)?.['retry_after']
  if (typeof declared === 'number' && Number.isFinite(declared) && declared >= 0) {
    return Math.round(declared * 1000)
  }
  return reply.retryAfterMs
}

/** Build the failure message for a reply the sender will not retry. */
function failureMessage(reply: DiscordPostReply): string {
  const detail = discordReplyMessage(reply)
  return `discord API returned HTTP ${String(reply.status)}${detail === undefined ? '' : `: ${detail}`}`
}

/**
 * Post one already-bounded chunk, waiting out at most {@link DiscordSendLimits.maxRetries} rate-limit
 * replies.
 *
 * @param options - channel, limits, transport, and delay seams.
 * @param token - bot token resolved for this operation.
 * @param content - one message body within the protocol limit.
 * @param signal - cancellation for the whole call; each attempt also carries its own timeout.
 * @throws Error on a non-2xx reply, an expired deadline, or a rate-limit delay above the configured cap.
 */
async function postChunk(
  options: DiscordSenderOptions,
  token: string,
  content: string,
  signal: AbortSignal,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const timeout = deadline(signal, options.requestTimeoutMs, TIMEOUT_CODE)
    let reply: DiscordPostReply
    try {
      reply = await options.post({ channelId: options.channel, token, content }, timeout.signal)
    } catch (error: unknown) {
      if (timeoutOf(timeout.signal, TIMEOUT_CODE) !== undefined) {
        throw new Error(`discord_send timed out after ${String(options.requestTimeoutMs)}ms`)
      }
      throw error
    } finally {
      timeout[Symbol.dispose]()
    }
    if (reply.status >= 200 && reply.status < 300) return
    if (reply.status !== 429 || attempt >= options.maxRetries) throw new Error(failureMessage(reply))
    const delay = retryDelayMs(reply)
    if (delay === undefined) throw new Error('discord rate limit reply carried no retry delay')
    if (delay > options.maxRetryWaitMs) {
      throw new Error(`discord rate limit asks for ${String(delay)}ms, above the configured ${String(options.maxRetryWaitMs)}ms`)
    }
    await options.wait(delay, signal)
  }
}

/**
 * Deliver one message body to the configured channel, posting several messages when it exceeds the
 * protocol limit.
 *
 * Broadcast mentions are rewritten before chunking so the rewrite cannot push a chunk over the
 * limit. Chunks post sequentially and the call fails at the first chunk Discord refuses, leaving
 * earlier chunks delivered; {@link DiscordSendResult} is returned only when every chunk succeeded.
 *
 * @param options - channel, limits, transport, and delay seams.
 * @param token - bot token resolved for this operation.
 * @param content - complete body composed by the model.
 * @param signal - cancellation shared across every attempt.
 * @returns how many messages were posted, their total length, and the rewrite count.
 */
export async function sendDiscordMessage(
  options: DiscordSenderOptions,
  token: string,
  content: string,
  signal: AbortSignal,
): Promise<DiscordSendResult> {
  const defanged = defangBroadcastMentions(content)
  const chunks = chunkContent(defanged.content)
  if (chunks.length === 0) throw new Error('discord_send requires a non-empty message body')
  if (chunks.length > options.maxChunksPerCall) {
    throw new Error(
      `message needs ${String(chunks.length)} Discord messages, above the configured limit of `
      + `${String(options.maxChunksPerCall)} (${String(defanged.content.length)} characters)`,
    )
  }
  let characters = 0
  for (const chunk of chunks) {
    await postChunk(options, token, chunk, signal)
    characters += chunk.length
  }
  return { chunks: chunks.length, characters, suppressedBroadcastMentions: defanged.count }
}
