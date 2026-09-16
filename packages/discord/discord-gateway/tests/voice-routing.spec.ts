import { afterEach, describe, expect, it, vi } from 'vitest'
import { drain, harness, inbound } from './support.ts'

afterEach(() => vi.unstubAllGlobals())
const audioAttachments = [{ url: 'https://cdn.discordapp.com/attachments/1/2/voice.ogg', filename: 'voice.ogg', size: 3 }]

describe('Discord voice routing', () => {
  it('rejects an unapproved sender before downloading or opening a session', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    const h = harness()
    h.router.handle(inbound({ authorId: '999999999999999999', content: '', audioAttachments }))
    await drain()
    expect(fetcher).not.toHaveBeenCalled()
    expect(h.calls).toEqual([])
    await h.router.dispose()
  })

  it('routes an admitted audio-only message as ordinary user text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ogg')))
    const transcribe = vi.fn(async () => 'Check the current build.')
    const h = harness({ replyText: 'The build is green.' })
    Object.assign(h.ctx, { get: (name: string) => name === 'speech'
      ? { maxAudioBytes: 1024, timeoutMs: 1000, transcribe } : undefined })
    h.router.handle(inbound({ content: '', audioAttachments }))
    await drain()
    expect(transcribe).toHaveBeenCalledOnce()
    expect(h.calls).toContain('followup:Voice transcript:\nCheck the current build.')
    expect(h.posted[0]?.content).toBe('The build is green.')
    await h.router.dispose()
  })

  it('explains a missing provider without creating an empty agent turn', async () => {
    const h = harness()
    Object.assign(h.ctx, { get: () => undefined })
    h.router.handle(inbound({ content: '', audioAttachments }))
    await drain()
    expect(h.calls).not.toContain('agent-create')
    expect(JSON.stringify(h.posted)).toContain('Voice transcription is not configured')
    await h.router.dispose()
  })
})
