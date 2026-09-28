/** Zod validation for attachment references kept in durable plugin records. @module @deepseek-ai/dsh-attachment/schema */

import { z } from 'zod'
import type { ImageMediaType } from './types.ts'

const positiveInteger = z.number().int().positive()

/**
 * Field validation for one stored `ImageAttachmentRef`, for plugins that keep references in their own
 * durable records. It checks shapes only: `attachmentId` parses as a plain string that callers brand
 * with `AttachmentId()`, and only `ctx.attachments` reads prove the object exists and matches.
 * Callers may `extend` it with record-specific fields.
 */
export const imageAttachmentRefSchema = z.object({
  attachmentId: z.string().min(1),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const satisfies readonly ImageMediaType[]),
  bytes: positiveInteger,
  width: positiveInteger,
  height: positiveInteger,
  name: z.string().optional(),
  originalDimensions: z.object({ width: positiveInteger, height: positiveInteger }).optional(),
})
