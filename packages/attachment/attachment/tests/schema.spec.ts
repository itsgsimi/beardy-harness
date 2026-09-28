import { describe, expect, it } from 'vitest'
import { imageAttachmentRefSchema } from '../src/index.ts'

const stored = { attachmentId: 'sha256-a', mediaType: 'image/jpeg', bytes: 10, width: 4, height: 3 }

describe('stored image reference validation', () => {
  it('accepts a stored reference with and without its optional fields', () => {
    expect(imageAttachmentRefSchema.parse(stored)).toEqual(stored)
    const full = { ...stored, name: 'door.jpg', originalDimensions: { width: 8, height: 6 } }
    expect(imageAttachmentRefSchema.parse(full)).toEqual(full)
  })

  it('rejects an empty id, an unsupported media type, and non-positive dimensions', () => {
    expect(imageAttachmentRefSchema.safeParse({ ...stored, attachmentId: '' }).success).toBe(false)
    expect(imageAttachmentRefSchema.safeParse({ ...stored, mediaType: 'image/bmp' }).success).toBe(false)
    expect(imageAttachmentRefSchema.safeParse({ ...stored, width: 0 }).success).toBe(false)
    expect(imageAttachmentRefSchema.safeParse({ ...stored, originalDimensions: { width: 8, height: 1.5 } }).success).toBe(false)
  })
})
