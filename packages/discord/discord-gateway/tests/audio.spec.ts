import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SpeechWhisper } from '@deepseek-ai/dsh-speech-whisper'
import { parseMessageCreate } from '../src/gateway.ts'
import { transcribeDiscordAudio } from '../src/audio.ts'

const contexts: Context[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function speech(maxAudioBytes: number, transcript: string): SpeechWhisper {
  const ctx = new Context()
  contexts.push(ctx)
  const provider = new SpeechWhisper(ctx, {
    endpoint: 'http://127.0.0.1:1', ffmpegPath: 'ffmpeg', maxAudioBytes,
    maxDurationSeconds: 60, timeoutMs: 1000, maxConcurrent: 1,
  })
  vi.spyOn(provider, 'transcribe').mockResolvedValue(transcript)
  return provider
}
function message(url = 'https://cdn.discordapp.com/attachments/1/2/voice.ogg', size = 4) {
  return parseMessageCreate({ id: '1', channel_id: '2', author: { id: '3' }, content: '',
    attachments: [{ filename: 'voice-message.ogg', content_type: 'audio/ogg', size, url }] })!
}
describe('Discord voice messages', () => {
  it('preserves a text message without audio attachments', async () => {
    const parsed = parseMessageCreate({ id: '1', channel_id: '2', author: { id: '3' }, content: 'Hello' })!
    expect(await transcribeDiscordAudio(parsed, speech(100, ''), new AbortController().signal)).toEqual(parsed)
  })

  it('retains audio-only voice notes and creates text carrying the sender and channel identity', async () => {
    const provider = speech(100, 'Please inspect the failing tests.')
    const fetcher = vi.fn(async (_url: URL, _init: RequestInit) => new Response('ogg!'))
    vi.stubGlobal('fetch', fetcher)
    const parsed = message()
    expect(parsed.audioAttachments).toHaveLength(1)
    const result = await transcribeDiscordAudio(parsed, provider, new AbortController().signal)
    expect(result.content).toBe([parsed.content, 'Voice transcript:\nPlease inspect the failing tests.'].filter(Boolean).join('\n\n'))
    expect(result.authorId).toBe('3')
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' })
  })
  it.each(['http://cdn.discordapp.com/attachments/1', 'https://example.com/attachments/1',
    'https://cdn.discordapp.com@127.0.0.1/attachments/1', 'https://cdn.discordapp.com/not-attachments',
    'https://user@cdn.discordapp.com/attachments/1', 'https://:pass@cdn.discordapp.com/attachments/1',
    'https://cdn.discordapp.com:444/attachments/1'])('refuses non-CDN URLs: %s', async (url) => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    await expect(transcribeDiscordAudio(message(url), speech(100, ''), new AbortController().signal)).rejects.toThrow('URL')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('refuses oversized attachments before download and empty transcripts', async () => {
    const fetcher = vi.fn(async (_url: URL, _init: RequestInit) => new Response('ogg!')); vi.stubGlobal('fetch', fetcher)
    await expect(transcribeDiscordAudio(message(), speech(3, ''), new AbortController().signal)).rejects.toThrow('limit')
    expect(fetcher).not.toHaveBeenCalled()
    await expect(transcribeDiscordAudio(message(), speech(100, ''), new AbortController().signal)).rejects.toThrow('No speech')
  })

  it.each([Number.NaN, -1])('rejects an invalid declared audio size %s before download', async (size) => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    await expect(transcribeDiscordAudio(message(undefined, size), speech(100, ''), new AbortController().signal))
      .rejects.toThrow('limit')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    ['a network error', () => Response.error()],
    ['an empty body', () => new Response(null)],
  ] as const)('rejects a download that ends with %s', async (_label, response) => {
    vi.stubGlobal('fetch', vi.fn(async () => response()))
    await expect(transcribeDiscordAudio(message(), speech(100, ''), new AbortController().signal))
      .rejects.toThrow('Could not download the Discord recording')
  })

  it('accepts the media CDN and appends its transcript', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ogg!')))
    const result = await transcribeDiscordAudio(
      message('https://media.discordapp.net/attachments/1/2/voice.ogg'),
      speech(100, 'Spoken answer'), new AbortController().signal)
    expect(result.content).toContain('Voice transcript:\nSpoken answer')
  })
})
