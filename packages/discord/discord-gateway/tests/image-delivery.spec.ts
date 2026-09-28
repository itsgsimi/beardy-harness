import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { discordImageMessage, outboxRecord } from '../src/domain.ts'
import type { DiscordImageMessage, OutboxRecord } from '../src/domain.ts'
import { CHANNEL, harness, tableFromMap } from './support.ts'

interface SentRequest { readonly headers: Record<string, string>; readonly body: unknown }

const sent: SentRequest[] = []

afterEach(() => {
  sent.length = 0
  vi.unstubAllGlobals()
})

function stubFetch(fail = false): void {
  vi.stubGlobal('fetch', async (_input: string | URL, init?: RequestInit) => {
    if (fail) throw new Error('ECONNREFUSED')
    sent.push({ headers: { ...(init?.headers as Record<string, string>) }, body: init?.body })
    return new Response('{"id":"posted"}', { status: 200 })
  })
}

const image: DiscordImageMessage['image'] = {
  attachmentId: 'sha256:frame', mediaType: 'image/jpeg', bytes: 3, width: 16, height: 12, name: 'front-door-1.jpg',
}

const notice: DiscordImageMessage = { content: '**Front door** · 12:00: Doorbell rang', image }

/** Synthetic one-pixel PNG. */
const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC',
  'base64',
))

async function form(request: SentRequest): Promise<{ payload: unknown; file?: File }> {
  const body = request.body as FormData
  const file = body.get('files[0]')
  const field = body.get('payload_json')
  const payload: unknown = JSON.parse(typeof field === 'string' ? field : '')
  return { payload, ...file instanceof File ? { file } : {} }
}

describe('Discord image notices', () => {
  it('persists an image notice and uploads the verified stored frame with its text', async () => {
    stubFetch()
    const records = new Map<string, OutboxRecord>()
    const readImage = vi.fn(async () => ({ data: new Uint8Array([0xff, 0xd8, 0xff]) }))
    const h = harness({ outboxStorage: tableFromMap(records, record => outboxRecord.parse(record)), attachments: { readImage } })
    try {
      await h.router.deliver(CHANNEL, notice, 'camera:ring-101-1')
      expect(records.get('camera:ring-101-1')?.chunks).toEqual([notice])
      await vi.waitFor(() => { expect(sent).toHaveLength(1) })
      expect(readImage).toHaveBeenCalledWith({ ...image }, expect.any(AbortSignal))
      expect(sent[0]?.headers).toEqual({ authorization: 'Bot tok' })
      const { payload, file } = await form(sent[0]!)
      expect(payload).toEqual({ content: notice.content, allowed_mentions: { parse: [] }, attachments: [{ id: 0, filename: 'front-door-1.jpg' }] })
      expect([file?.name, file?.type, [...new Uint8Array(await file!.arrayBuffer())]]).toEqual(['front-door-1.jpg', 'image/jpeg', [0xff, 0xd8, 0xff]])
      await vi.waitFor(() => { expect(records.get('camera:ring-101-1')?.completedAt).toBeDefined() })
    } finally {
      h.controller.abort()
      await h.router.dispose()
    }
  })

  it('posts text only when the stored frame is unreadable or no store is mounted', async () => {
    stubFetch()
    for (const attachments of [{ readImage: async () => { throw new Error('digest mismatch') } }, undefined]) {
      const h = harness({ ...attachments === undefined ? {} : { attachments } })
      try {
        await h.router.deliver(CHANNEL, { content: 'Doorbell rang', image: { ...image, name: undefined, mediaType: 'image/png' } })
      } finally {
        h.controller.abort()
        await h.router.dispose()
      }
      expect(h.warnings.some(warning => warning.includes(attachments === undefined ? 'no attachment store is mounted' : 'stored image sha256:frame is unreadable'))).toBe(true)
    }
    expect(sent.map(request => JSON.parse(String(request.body)) as Record<string, unknown>)).toEqual([
      { content: 'Doorbell rang', allowed_mentions: { parse: [] } },
      { content: 'Doorbell rang', allowed_mentions: { parse: [] } },
    ])
  })

  it('posts text only when retention deletes the frame after the outbox accepted the notice', async () => {
    stubFetch()
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-discord-image-'))
    try {
      const store = new LocalAttachmentStore(new Context(), { dshHome })
      const frame = await store.saveImage({ data: PNG, mediaType: 'image/png', name: 'front-door-1.png' })
      const readImage = async (ref: unknown, signal?: AbortSignal): Promise<{ data: Uint8Array }> => {
        await store.deleteImage(ref as ImageAttachmentRef)
        return store.readImage(ref as ImageAttachmentRef, signal)
      }
      const records = new Map<string, OutboxRecord>()
      const h = harness({ outboxStorage: tableFromMap(records, record => outboxRecord.parse(record)), attachments: { readImage } })
      try {
        await h.router.deliver(CHANNEL, { content: 'Doorbell rang', image: { ...frame, attachmentId: String(frame.attachmentId) } }, 'camera:ring-101-2')
        await vi.waitFor(() => { expect(records.get('camera:ring-101-2')?.completedAt).toBeDefined() })
      } finally {
        h.controller.abort()
        await h.router.dispose()
      }
      expect(h.warnings.some(warning => warning.includes(`stored image ${String(frame.attachmentId)} is unreadable; posting text only: Attachment object is missing.`))).toBe(true)
      expect(sent.map(request => JSON.parse(String(request.body)) as Record<string, unknown>)).toEqual([
        { content: 'Doorbell rang', allowed_mentions: { parse: [] } },
      ])
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })

  it('names an unnamed frame from its media type', async () => {
    stubFetch()
    const h = harness({ attachments: { readImage: async () => ({ data: new Uint8Array([1]) }) } })
    try {
      await h.router.deliver(CHANNEL, { content: 'x', image: { ...image, name: undefined, mediaType: 'image/png' } })
      await h.router.deliver(CHANNEL, { content: 'y', image: { ...image, name: 'shot', originalDimensions: { width: 32, height: 24 } } })
    } finally {
      h.controller.abort()
      await h.router.dispose()
    }
    expect(await Promise.all(sent.map(async request => (await form(request)).file?.name))).toEqual(['image.png', 'shot.jpg'])
  })

  it('logs a failed direct image post without an outbox', async () => {
    stubFetch(true)
    const h = harness({ attachments: { readImage: async () => ({ data: new Uint8Array([1]) }) } })
    try {
      await expect(h.router.deliver(CHANNEL, notice)).resolves.toBeUndefined()
    } finally {
      h.controller.abort()
      await h.router.dispose()
    }
    expect(h.warnings.some(warning => warning.startsWith(`discord-gateway: notice to channel ${CHANNEL} failed`))).toBe(true)
  })

  it('refuses an image notice without visible text', () => {
    expect(discordImageMessage.safeParse({ content: '  ', image }).success).toBe(false)
    const pending = { channelId: CHANNEL, chunks: [notice], cursor: 0, ordinal: 1, createdAt: 1, nextAttemptAt: 1, attempts: 0 }
    expect(outboxRecord.safeParse(pending).success).toBe(true)
  })
})
