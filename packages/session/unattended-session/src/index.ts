/**
 * Shared machinery for opening and awaiting unattended root Agent Sessions, consumed by webhook
 * ingress, the cron scheduler, and the Discord gateway.
 * @module @deepseek-ai/dsh-unattended-session
 */

export { openUnattendedSession } from './open.ts'
export type { UnattendedSession, UnattendedSessionSpec } from './open.ts'
export { awaitTurn, lastAssistantText, sleep } from './turn.ts'
export type { AwaitTurnOptions } from './turn.ts'
