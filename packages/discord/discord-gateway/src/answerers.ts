/**
 * Reply matching and prompt text for the approval and question answerers. A pending request lives
 * in the conversation router; this module decides which reaction, line, or number answers it and
 * what the channel is asked to choose between.
 * @module @deepseek-ai/dsh-discord-gateway/answerers
 */

import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { DiscordAnswerForm } from './types.ts'

/** Reaction that grants one approval; Discord reports unicode emoji by the character itself. */
export const APPROVAL_ALLOW_EMOJI = '✅'

/** Reaction that rejects one approval. */
export const APPROVAL_REJECT_EMOJI = '❌'

/**
 * Match one reaction emoji against the approval vocabulary.
 * @param emojiName - Unicode reaction received from Discord.
 * @returns the one-time decision, or undefined for an unrelated reaction.
 */
export function approvalOutcomeForReaction(emojiName: string): ApprovalOutcome | undefined {
  if (emojiName === APPROVAL_ALLOW_EMOJI) return 'allowed-once'
  if (emojiName === APPROVAL_REJECT_EMOJI) return 'rejected'
  return undefined
}

/**
 * Match one text line against the yes/no approval vocabulary, case-insensitively.
 * @param line - User's complete reply.
 * @returns the one-time decision, or undefined for an unrelated answer.
 */
export function approvalOutcomeForLine(line: string): ApprovalOutcome | undefined {
  const lowered = line.trim().toLowerCase()
  if (lowered === 'yes') return 'allowed-once'
  if (lowered === 'no') return 'rejected'
  return undefined
}

/** Whole minutes for prompt text; a sub-minute window still reads as one minute. */
function minutesFor(ms: number): string {
  return String(Math.max(1, Math.round(ms / 60_000)))
}

/**
 * Build the channel prompt that asks for one approval decision.
 * @param toolName - Tool awaiting permission.
 * @param reason - Full reason supplied by the approval requester.
 * @param forms - Reply forms enabled by the deployment.
 * @param timeoutMs - Approval expiry in milliseconds.
 * @returns the complete prompt, including every supported answer form.
 */
export function buildApprovalPrompt(
  toolName: string,
  reason: string | undefined,
  forms: readonly DiscordAnswerForm[],
  timeoutMs: number,
): string {
  const parts = [`Approval needed — ${toolName}${reason === undefined || reason === '' ? '' : `: ${reason}`}.`]
  if (forms.includes('component')) parts.push('Use Allow once or Reject below.')
  if (forms.includes('reaction')) parts.push(`React ${APPROVAL_ALLOW_EMOJI} to allow once or ${APPROVAL_REJECT_EMOJI} to reject.`)
  if (forms.includes('text')) parts.push('Reply yes to allow once or no to reject.')
  parts.push(`Expires in ${minutesFor(timeoutMs)} min.`)
  return parts.join(' ')
}

/**
 * Build the channel prompt for one question of a pending request.
 * @param question - Question text, details, and canonical options.
 * @param index - Zero-based question position.
 * @param total - Number of questions in the request.
 * @param forms - Enabled reply forms; defaults to text.
 * @returns complete text with instructions for available controls and fallback answers.
 */
export function buildQuestionPrompt(
  question: AskUserQuestionItem,
  index: number,
  total: number,
  forms: readonly DiscordAnswerForm[] = ['text'],
): string {
  const heading = total > 1 ? `Question ${String(index + 1)} of ${String(total)}` : 'A question needs your answer'
  const parts = [`${heading}${question.header === undefined || question.header === '' ? '' : ` — ${question.header}`}: ${question.question}`]
  if (question.detail !== undefined && question.detail !== '') parts.push(question.detail)
  const options = question.options ?? []
  if (options.length > 0) {
    parts.push(options.map((option, position) => `${String(position + 1)}. ${option.label}${option.description ? ` — ${option.description}` : ''}`).join('\n'))
    const menu = forms.includes('component') && options.length <= 25
    if (menu) parts.push(question.multiSelect === true ? 'Choose one or more answers from the menu below.' : 'Choose an answer from the menu below.')
    if (forms.includes('text') || !menu) parts.push(question.multiSelect === true
      ? 'Reply with the numbers you choose, comma-separated (for example 1,3).'
      : 'Reply with the number of your choice.')
  } else {
    parts.push('Reply with your answer.')
  }
  return parts.join('\n')
}

/**
 * Match one reply line against one question. A numbered reply selects option labels; a question
 * without options takes the whole line as free text. Anything that does not answer returns
 * `undefined` and the request keeps waiting.
 * @param question - Current question and canonical option labels.
 * @param line - Numbered selections or a free-text answer.
 * @returns the resolved answer, or undefined when the reply does not match.
 */
export function parseQuestionAnswer(
  question: AskUserQuestionItem,
  line: string,
): AskUserQuestionAnswerItem | undefined {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  const options = question.options ?? []
  if (options.length === 0) return { id: question.id, selected: [], custom: trimmed }
  const positions = trimmed.split(',').map(part => part.trim()).filter(part => part !== '')
  if (positions.length === 0) return undefined
  if (question.multiSelect !== true && positions.length > 1) return undefined
  const chosen: string[] = []
  for (const position of positions) {
    if (!/^\d+$/.test(position)) return undefined
    const index = Number(position) - 1
    const option = options[index]
    if (option === undefined || chosen.includes(option.label)) return undefined
    chosen.push(option.label)
  }
  return { id: question.id, selected: chosen }
}
