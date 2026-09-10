/**
 * Discord message fields shared by gateway presenters and the REST transport.
 * @module @deepseek-ai/dsh-tool-discord/types
 */

/** One labeled value in a Discord embed. */
export interface DiscordEmbedField {
  readonly name: string
  readonly value: string
  readonly inline?: boolean | undefined
}

/** Rich message card using Discord's native embed fields. */
export interface DiscordEmbed {
  readonly title?: string | undefined
  readonly description?: string | undefined
  readonly color?: number | undefined
  readonly fields?: readonly DiscordEmbedField[] | undefined
  readonly footer?: { readonly text: string } | undefined
}

/** Interactive button whose opaque custom id resolves an application-owned action. */
export interface DiscordButton {
  readonly type: 2
  readonly style: 1 | 2 | 3 | 4
  readonly label: string
  readonly custom_id: string
  readonly disabled?: boolean | undefined
}

/** One label and canonical value in a string selector. */
export interface DiscordSelectOption {
  readonly label: string
  readonly value: string
  readonly description?: string | undefined
  readonly default?: boolean | undefined
}

/** Native string selector for one or more application-owned choices. */
export interface DiscordSelect {
  readonly type: 3
  readonly custom_id: string
  readonly options: readonly DiscordSelectOption[]
  readonly placeholder?: string | undefined
  readonly min_values?: number | undefined
  readonly max_values?: number | undefined
  readonly disabled?: boolean | undefined
}

/** One Discord component row containing buttons or a string selector. */
export interface DiscordActionRow {
  readonly type: 1
  readonly components: readonly (DiscordButton | DiscordSelect)[]
}

/** Visible message content and optional native cards and controls, already within Discord limits. */
export interface DiscordMessageBody {
  readonly content: string
  readonly embeds?: readonly DiscordEmbed[] | undefined
  readonly components?: readonly DiscordActionRow[] | undefined
}
