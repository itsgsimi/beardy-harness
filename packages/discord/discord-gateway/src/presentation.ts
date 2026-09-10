/** Discord cards and controls derived from command results and pending requests. @module @deepseek-ai/dsh-discord-gateway/presentation */

import { chunkContent, defangBroadcastMentions, sliceUnits } from '@deepseek-ai/dsh-tool-discord'
import type { DiscordActionRow, DiscordMessageBody } from '@deepseek-ai/dsh-tool-discord'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Fresh identity linking a Discord component to one pending prompt. */
export type DiscordPromptId = Branded<'DiscordPromptId'>

/**
 * Brand a freshly generated prompt identity.
 * @param id - Unique identity generated for this pending prompt.
 * @returns the unchanged branded identity.
 */
export function DiscordPromptId(id: string): DiscordPromptId { return id as DiscordPromptId }

/** Options shared by the gateway's informational cards. */
export interface CardOptions {
  readonly title: string
  readonly color: number
  readonly controls?: readonly DiscordActionRow[]
}

/**
 * Render complete text into bounded cards; the final card owns any controls.
 * @param text - Complete command or notice text, preserved across cards.
 * @param options - Card title (truncated to 256 UTF-16 units), accent, and optional controls.
 * @returns protocol-sized cards with inert mentions.
 */
export function renderCards(text: string, options: CardOptions): DiscordMessageBody[] {
  const chunks = chunkContent(defangBroadcastMentions(text).content)
  const title = sliceUnits(options.title, 256)[0]
  return chunks.map((description, index) => ({
    content: '',
    embeds: [{ title, description, color: options.color,
      ...(chunks.length > 1 ? { footer: { text: `${String(index + 1)} / ${String(chunks.length)}` } } : {}),
    }],
    ...(index === chunks.length - 1 && options.controls !== undefined ? { components: options.controls } : {}),
  }))
}

/** Controls explicitly operate on the channel's current conversation. */
export const CONVERSATION_CONTROLS: readonly DiscordActionRow[] = [{
  type: 1,
  components: [
    { type: 2, style: 2, custom_id: 'dsh:command:status', label: 'Current status' },
    { type: 2, style: 4, custom_id: 'dsh:command:stop', label: 'Stop current turn' },
    { type: 2, style: 1, custom_id: 'dsh:command:new', label: 'New conversation' },
  ],
}]

/**
 * Create controls for one pending approval, offering only the supported one-time decision.
 * @param requestId - Fresh identity of the pending request.
 * @returns an allow/reject button row.
 */
export function approvalControls(requestId: DiscordPromptId): readonly DiscordActionRow[] {
  return [{ type: 1, components: [
    { type: 2, style: 3, custom_id: `dsh:approval:${requestId}:yes`, label: 'Allow once' },
    { type: 2, style: 4, custom_id: `dsh:approval:${requestId}:no`, label: 'Reject' },
  ] }]
}

/**
 * Create a choice menu when Discord can represent every option without hiding choices.
 * @param question - Current question, whose canonical labels remain in the resolver.
 * @param requestId - Fresh identity of this question's prompt.
 * @returns a single or multiple choice menu, or no controls for free text or more than 25 choices.
 */
export function questionControls(question: AskUserQuestionItem, requestId: DiscordPromptId): readonly DiscordActionRow[] {
  const options = question.options ?? []
  if (options.length === 0 || options.length > 25) return []
  return [{ type: 1, components: [{
    type: 3,
    custom_id: `dsh:question:${requestId}`,
    placeholder: question.multiSelect === true ? 'Choose one or more answers' : 'Choose an answer',
    min_values: 1,
    max_values: question.multiSelect === true ? options.length : 1,
    options: options.map((option, index) => ({
      label: sliceUnits(option.label, 100)[0] ?? String(index + 1),
      value: String(index + 1),
      ...(option.description ? { description: sliceUnits(option.description, 100)[0] } : {}),
    })),
  }] }]
}
