/**
 * Types of the Discord Gateway listener: the inbound message the protocol layer hands up, the
 * validated settings the conversation router needs, and the message provenance a routed message
 * carries into the Session log.
 * @module @deepseek-ai/dsh-discord-gateway/types
 */

import type { OutboxSettings } from './outbox.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** One message admitted from Discord for the user to converse with an agent. */
    discord: {
      readonly kind: 'discord'
      /** Guild the message came from; empty for a direct message. */
      readonly guildId: string
      /** Discord channel carrying the conversation. */
      readonly channelId: string
      /** The admitted message's own id. */
      readonly messageId: string
      /** Author's user id, already checked against the configured allowlist. */
      readonly authorId: string
      readonly form: 'notice'
      readonly summary: string
    }
  }
}

/** One channel message the Gateway dispatched, reduced to the fields routing uses. */
export interface DiscordInboundMessage {
  /** Encoded audio references; fetched only after sender and channel admission. */
  readonly audioAttachments?: readonly DiscordAudioAttachment[]
  /** Discord's id for this message. */
  readonly id: string
  /** Channel the message was posted in. */
  readonly channelId: string
  /** Guild id, or the empty string for a direct message. */
  readonly guildId: string
  /** Author's user id. */
  readonly authorId: string
  /** True for accounts owned by bots, including this one. */
  readonly bot: boolean
  /** Discord's channel type; `1` is a direct message. */
  readonly channelType: number
  /** Message text with JSON attachment references; file contents are not fetched. */
  readonly content: string
  /** User ids this message mentions, from Discord's own mention parsing. */
  readonly mentionedUserIds: readonly string[]
  /** Author id of the message this one replies to; empty when it replies to nothing. */
  readonly replyToAuthorId: string
}

/** Audio metadata supplied by Discord's attachment payload. */
export interface DiscordAudioAttachment {
  readonly url: string
  readonly filename: string
  readonly size: number
}

/** One reaction the Gateway dispatched, reduced to the fields an answerer matches on. */
export interface DiscordInboundReaction {
  /** User who added the reaction. */
  readonly userId: string
  /** Channel holding the reacted message. */
  readonly channelId: string
  /** Message the reaction was added to. */
  readonly messageId: string
  /** Unicode character or name of the emoji, as Discord reports it. */
  readonly emojiName: string
}

/** Reply forms a pending approval or question accepts from an allowlisted user. */
export type DiscordAnswerForm = 'reaction' | 'text' | 'component'

/** Validated plugin settings the conversation router reads, detached from schemastery types. */
export interface GatewaySettings extends OutboxSettings {
  /** Render command and lifecycle notices as Discord cards. */
  readonly richMessages: boolean
  /** Preset commands owned by another UI and omitted from Discord. */
  readonly excludedPresetCommands: readonly string[]
  /** Accent color of Discord cards. */
  readonly accentColor: number
  /** Mark admitted messages with processing and completion reactions. */
  readonly reactionStatus: boolean
  /** Per-attempt outbound HTTP bound. */
  readonly replyRequestTimeoutMs: number
  /** Additional rate-limit retries for immediate replies. */
  readonly replyMaxRetries: number
  /** Longest accepted server-requested retry delay. */
  readonly replyMaxRetryWaitMs: number
  /** Maximum chunks of an immediate reply. */
  readonly replyMaxChunksPerCall: number
  /** Maximum simultaneous native interactions. */
  readonly interactionMaxPending: number
  /** Completed native interaction ids retained to suppress duplicate delivery. */
  readonly interactionReceiptLimit: number
  /** Retry delay after a failed cold reminder read or resume. */
  readonly wakeRetryMs: number
  /** Workspace every routed conversation runs in. */
  readonly workspacePath: string
  /** Agent preset mounted into each routed Session. */
  readonly agentPreset: string
  /** Permission preset applied to each routed Session. */
  readonly permissionPreset: string
  /** Prefix of the generated Session title, followed by the channel id. */
  readonly titlePrefix: string
  /** Longest inbound text handed to the agent; longer text is cut and marked. */
  readonly maxInputChars: number
  /** Longest wait for one routed turn to settle before its reply is abandoned. */
  readonly turnTimeoutMs: number
  /** Silence after which the live Agent handle is released; the durable record stays. */
  readonly idleReleaseMs: number
  /** Silence after which the next message starts a fresh Session and replaces the record. */
  readonly conversationMaxAgeMs: number
  /** Window in which one channel's messages join into a single turn; `0` answers each message. */
  readonly inboundDebounceMs: number
  /** Guild channels are answered only when the bot is mentioned or replied to. */
  readonly guildRequireMention: boolean
  /** Send `POST /channels/{id}/typing` while an inbound turn runs. */
  readonly typingIndicator: boolean
  /** Longest wait for a ✅/❌ or yes/no answer to an approval before it reports cancelled. */
  readonly approvalTimeoutMs: number
  /** Longest wait for one question's answer before the request rejects unanswered. */
  readonly questionTimeoutMs: number
  /** Reply forms that answer a pending approval or question; all three by default. */
  readonly answerers: readonly DiscordAnswerForm[]
}

/** Connection state reported to diagnostics. */
export type GatewayStatus =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'disconnected'; readonly reason: string }
  | { readonly kind: 'stopped'; readonly reason: string }
