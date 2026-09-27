/** Session recall origin inferred from first-party Session id namespaces. */

import type { SessionHeader } from '@deepseek-ai/dsh-session'

/** Origins available to session recall callers. */
export type SessionRecallOrigin = 'interactive' | 'cron' | 'discord'

/**
 * Classify a Session by the `cron-` and `discord-` id namespaces the cron and
 * Discord launchers issue. A subagent child (positive `delegationDepth`)
 * classifies by its direct parent's id, so work a cron or Discord run
 * delegates keeps that run's origin; every other id is `interactive`. The
 * result is a recall preference, never an authorization identity.
 * @param header - persisted or live Session header.
 * @returns origin used for recall filtering, ranking, and presentation.
 */
export function sessionRecallOrigin(
  header: Pick<SessionHeader, 'id' | 'parentSession' | 'delegationDepth'>,
): SessionRecallOrigin {
  const source = header.parentSession !== undefined && (header.delegationDepth ?? 0) > 0
    ? header.parentSession
    : header.id
  if (source.startsWith('cron-')) return 'cron'
  if (source.startsWith('discord-')) return 'discord'
  return 'interactive'
}
