/**
 * Shared machinery for opening, resuming, and awaiting unattended root Agent Sessions, consumed by
 * webhook ingress, the cron scheduler, and the Discord gateway.
 * @module @deepseek-ai/dsh-unattended-session
 */

export { openUnattendedSession, resumeUnattendedSession } from './open.ts'
export type { ResumeUnattendedSessionSpec, UnattendedSession, UnattendedSessionSpec } from './open.ts'
export { awaitTurn, lastAssistantText, sleep } from './turn.ts'
export type { AwaitTurnOptions } from './turn.ts'
