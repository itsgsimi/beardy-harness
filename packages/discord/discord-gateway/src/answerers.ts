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

/** Match one reaction emoji against the approval vocabulary. */
export function approvalOutcomeForReaction(emojiName: string): ApprovalOutcome | undefined {
  if (emojiName === APPROVAL_ALLOW_EMOJI) return 'allowed-once'
  if (emojiName === APPROVAL_REJECT_EMOJI) return 'rejected'
  return undefined
}

/** Match one text line against the yes/no approval vocabulary, case-insensitively. */
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

/** Build the channel prompt that asks for one approval decision. */
export function buildApprovalPrompt(
  toolName: string,
  reason: string | undefined,
  forms: readonly DiscordAnswerForm[],
  timeoutMs: number,
): string {
  const parts = [`Approval needed — ${toolName}${reason === undefined || reason === '' ? '' : `: ${reason}`}.`]
  if (forms.includes('reaction')) parts.push(`React ${APPROVAL_ALLOW_EMOJI} to allow once or ${APPROVAL_REJECT_EMOJI} to reject.`)
  if (forms.includes('text')) parts.push('Reply yes to allow once or no to reject.')
  parts.push(`Expires in ${minutesFor(timeoutMs)} min.`)
  return parts.join(' ')
}

/** Build the channel prompt for one question of a pending request. */
export function buildQuestionPrompt(
  question: AskUserQuestionItem,
  index: number,
  total: number,
): string {
  const heading = total > 1 ? `Question ${String(index + 1)} of ${String(total)}` : 'A question needs your answer'
  const parts = [`${heading}${question.header === undefined || question.header === '' ? '' : ` — ${question.header}`}: ${question.question}`]
  if (question.detail !== undefined && question.detail !== '') parts.push(question.detail)
  const options = question.options ?? []
  if (options.length > 0) {
    parts.push(options.map((option, position) => `${String(position + 1)}. ${option.label}`).join('\n'))
    parts.push(question.multiSelect === true
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
