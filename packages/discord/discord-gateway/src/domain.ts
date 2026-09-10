/**
 * Durable Discord conversation routing, completed-turn checkpoints, and pending delivery chunks.
 * The session log holds the conversation itself; routing records identify sessions eligible for recovery.
 * @module @deepseek-ai/dsh-discord-gateway/domain
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

const button = z.object({
  type: z.literal(2), style: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  custom_id: z.string().min(1).max(100), label: z.string().min(1).max(80), disabled: z.boolean().optional(),
})
const select = z.object({
  type: z.literal(3), custom_id: z.string().min(1).max(100), placeholder: z.string().max(150).optional(),
  min_values: z.number().int().min(0).max(25).optional(), max_values: z.number().int().min(1).max(25).optional(),
  options: z.array(z.object({ label: z.string().min(1).max(100), value: z.string().min(1).max(100),
    description: z.string().max(100).optional(), default: z.boolean().optional(),
  })).min(1).max(25), disabled: z.boolean().optional(),
}).refine(menu => (menu.min_values ?? 1) <= (menu.max_values ?? 1)
  && (menu.max_values ?? 1) <= menu.options.length, 'Selection bounds must fit the available options')
  .refine(menu => new Set(menu.options.map(option => option.value)).size === menu.options.length,
    'Selection option values must be unique')
const embed = z.object({
  title: z.string().max(256).optional(), description: z.string().max(4096).optional(),
  color: z.number().int().min(0).max(0xffffff).optional(),
  fields: z.array(z.object({ name: z.string().min(1).max(256), value: z.string().min(1).max(1024),
    inline: z.boolean().optional(),
  })).max(25).optional(), footer: z.object({ text: z.string().max(2048) }).optional(),
})

const actionRow = z.union([
  z.object({ type: z.literal(1), components: z.array(button).min(1).max(5) }),
  z.object({ type: z.literal(1), components: z.tuple([select]) }),
])

/** Count the text Discord includes in the aggregate embed limit. */
function embedCharacters(items: readonly z.infer<typeof embed>[]): number {
  return items.reduce((total, item) => total + (item.title?.length ?? 0)
    + (item.description?.length ?? 0) + (item.footer?.text.length ?? 0)
    + (item.fields ?? []).reduce((count, field) => count + field.name.length + field.value.length, 0), 0)
}

/** Persisted presentation payload; mentions are suppressed by every transport operation. */
export const discordMessageBody = z.object({
  content: z.string().max(2000), embeds: z.array(embed).max(10).optional(),
  components: z.array(actionRow).max(5).optional(),
}).refine(body => body.content.trim() !== '' || embedCharacters(body.embeds ?? []) > 0, 'Message has no visible text')
  .refine(body => embedCharacters(body.embeds ?? []) <= 6000, 'Embed text exceeds 6000 UTF-16 units')
  .refine((body) => {
    const ids = (body.components ?? []).flatMap(row => row.components.map(component => component.custom_id))
    return ids.length === new Set(ids).size
  }, 'Component custom ids must be unique within a message')

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
  /** Session prefix already handed to the durable delivery queue. */
  deliveredThrough: z.number().int().nonnegative().optional(),
})

/** One channel's durable conversation routing record. */
export type ConversationRecord = z.infer<typeof conversationRecord>

/** One persisted delivery, including acknowledged chunks and bounded duplicate-detection receipts. */
export const outboxRecord = z.object({
  channelId: z.string(),
  chunks: z.array(z.union([z.string().max(2000), discordMessageBody])),
  cursor: z.number().int().nonnegative(),
  /** Enqueue order independent of backend iteration order or clock movement. */
  ordinal: z.number().int().positive(),
  createdAt: z.number(),
  nextAttemptAt: z.number(),
  attempts: z.number().int().nonnegative(),
  completedAt: z.number().optional(),
}).refine(record => record.cursor <= record.chunks.length)

/** Validated outbound delivery state. */
export type OutboxRecord = z.infer<typeof outboxRecord>

/** Gateway routing and delivery records in one unit; opening requires the declared unit version. */
export const discordGatewayDomainSpec = defineDomain({
  name: 'discord_gateway',
  version: 3,
  tables: {
    conversations: domainTable<string, ConversationRecord>(conversationRecord),
    outbox: domainTable<string, OutboxRecord>(outboxRecord),
  },
})
