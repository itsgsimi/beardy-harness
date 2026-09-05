/**
 * Types of the Discord Gateway listener: the inbound message the protocol layer hands up, the
 * validated settings the conversation router needs, and the message provenance a routed message
 * carries into the Session log.
 * @module @deepseek-ai/dsh-discord-gateway/types
 */

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
  /** Message text as Discord delivered it. */
  readonly content: string
}

/** Validated plugin settings the conversation router reads, detached from schemastery types. */
export interface GatewaySettings {
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
}

/** Connection state reported to diagnostics. */
export type GatewayStatus =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'disconnected'; readonly reason: string }
  | { readonly kind: 'stopped'; readonly reason: string }
