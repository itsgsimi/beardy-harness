/**
 * The durable conversation record of the Discord listener: which Agent Session one channel
 * continues in, surviving a restart. The record is the routing fact only; the session log holds
 * the conversation itself, and the Web UI lists the same Sessions either way.
 * @module @deepseek-ai/dsh-discord-gateway/domain
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/**
 * Durable shape of one channel's conversation record. `sessionId` is the Session the next
 * inbound message resumes; timestamps are epoch milliseconds taken when the listener routed work.
 */
export const conversationRecord = z.object({
  /** Discord channel id, identical to the table key. */
  channelId: z.string(),
  /** Agent Session this channel continues in. */
  sessionId: z.string(),
  /** Agent preset the Session was opened with; recorded for diagnostics. */
  agentPreset: z.string(),
  /** Workspace path the Session runs in; recorded for diagnostics. */
  workspacePath: z.string(),
  /** Epoch milliseconds when this record's Session was first opened. */
  openedAt: z.number(),
  /** Epoch milliseconds of the last inbound message routed to this Session. */
  lastInboundAt: z.number(),
})

/** One channel's durable conversation routing record. */
export type ConversationRecord = z.infer<typeof conversationRecord>

/** The gateway domain spec: one `conversations` table keyed by Discord channel id. */
export const discordGatewayDomainSpec = defineDomain({
  name: 'discord_gateway',
  version: 1,
  tables: { conversations: domainTable<string, ConversationRecord>(conversationRecord) },
})
