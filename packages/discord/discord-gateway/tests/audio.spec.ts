import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SpeechWhisper } from '@deepseek-ai/dsh-speech-whisper'
import { parseMessageCreate } from '../src/gateway.ts'
import { transcribeDiscordAudio } from '../src/audio.ts'

afterEach(() => vi.unstubAllGlobals())
function message(url = 'https://cdn.discordapp.com/attachments/1/2/voice.ogg') {
  return parseMessageCreate({ id: '1', channel_id: '2', author: { id: '3' }, content: '',
    attachments: [{ filename: 'voice-message.ogg', content_type: 'audio/ogg', size: 4, url }] })!
}
describe('Discord voice messages', () => {
  it('retains audio-only voice notes and creates text carrying the sender and channel identity', async () => {
    const transcribe = vi.fn(async () => 'Please inspect the failing tests.')
    const speech = { maxAudioBytes: 100, timeoutMs: 1000, transcribe } as unknown as SpeechWhisper
    const fetcher = vi.fn(async (_url: URL, _init: RequestInit) => new Response('ogg!'))
    vi.stubGlobal('fetch', fetcher)
    const parsed = message()
    expect(parsed.audioAttachments).toHaveLength(1)
    const result = await transcribeDiscordAudio(parsed, speech, new AbortController().signal)
    expect(result.content).toBe([parsed.content, 'Voice transcript:\nPlease inspect the failing tests.'].filter(Boolean).join('\n\n'))
    expect(result.authorId).toBe('3')
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' })
  })
  it.each(['http://cdn.discordapp.com/attachments/1', 'https://example.com/attachments/1',
    'https://cdn.discordapp.com@127.0.0.1/attachments/1', 'https://cdn.discordapp.com/not-attachments'])('refuses non-CDN URLs: %s', async (url) => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    await expect(transcribeDiscordAudio(message(url), { maxAudioBytes: 100 } as SpeechWhisper, new AbortController().signal)).rejects.toThrow('URL')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('refuses oversized attachments before download and empty transcripts', async () => {
    const fetcher = vi.fn(async (_url: URL, _init: RequestInit) => new Response('ogg!')); vi.stubGlobal('fetch', fetcher)
    await expect(transcribeDiscordAudio(message(), { maxAudioBytes: 3 } as SpeechWhisper, new AbortController().signal)).rejects.toThrow('limit')
    expect(fetcher).not.toHaveBeenCalled()
    const speech = { maxAudioBytes: 100, timeoutMs: 1000, transcribe: async () => '' } as unknown as SpeechWhisper
    await expect(transcribeDiscordAudio(message(), speech, new AbortController().signal)).rejects.toThrow('No speech')
  })
})
