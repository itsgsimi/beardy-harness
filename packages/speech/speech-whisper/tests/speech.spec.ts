import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import SpeechWhisper, { type Config } from '../src/index.ts'
import { collectBytes, decodeAudio } from '../src/audio.ts'

const config: Config = {
  endpoint: 'http://127.0.0.1:8178/inference', ffmpegPath: 'ffmpeg',
  maxAudioBytes: 1024 * 1024, maxDurationSeconds: 1, timeoutMs: 5000, maxConcurrent: 1,
}
const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose(); vi.unstubAllGlobals() })

function wav(seconds = 0.05): Uint8Array<ArrayBuffer> {
  const pcm = Buffer.alloc(Math.floor(seconds * 16000) * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
  return new Uint8Array(Buffer.concat([header, pcm]))
}
async function setup(overrides: Partial<Config> = {}) {
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(LocalSubprocess)
  const fiber = await ctx.plugin(SpeechWhisper, { ...config, ...overrides })
  return { ctx, fiber, speech: ctx.speech }
}

describe('speech transcription', () => {
  it('enforces exact byte limits across chunks', async () => {
    async function* data() { yield Buffer.from('ab'); yield Buffer.from('cd') }
    expect((await collectBytes(data(), 4)).toString()).toBe('abcd')
    await expect(collectBytes(data(), 3)).rejects.toThrow('limit')
  })
  it('decodes a real WAV through the managed subprocess and returns the backend transcript', async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const file = (init.body as FormData).get('file') as File
      expect(file.name).toBe('recording.wav')
      expect(Buffer.from(await file.arrayBuffer()).subarray(0, 4).toString()).toBe('RIFF')
      return Response.json({ text: '  Test dictation.  ' })
    })
    vi.stubGlobal('fetch', fetcher)
    const { speech } = await setup()
    expect(await speech.transcribe(new Response(wav()).body!, new AbortController().signal)).toBe('Test dictation.')
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('rejects long decoded audio and malformed data before contacting the backend', async () => {
    const { ctx } = await setup()
    const signal = new AbortController().signal
    await expect(decodeAudio(ctx.subprocess, wav(1.2), 'ffmpeg', 1, signal)).rejects.toThrow('limit')
    await expect(decodeAudio(ctx.subprocess, Buffer.from('invalid'), 'ffmpeg', 1, signal)).rejects.toThrow()
  })
  it('cancels a stalled upload, bounds concurrency, and drains on unload', async () => {
    const { speech, fiber, ctx } = await setup()
    const cancel = vi.fn()
    const pending = speech.transcribe(new ReadableStream({ cancel }), new AbortController().signal)
    const rejected = expect(pending).rejects.toThrow()
    await expect(speech.transcribe(new Response(wav()).body!, new AbortController().signal)).rejects.toThrow('busy')
    await fiber.dispose()
    await rejected
    expect(cancel).toHaveBeenCalledOnce()
    expect(ctx.get('speech')).toBeUndefined()
  })
  it('times out an upload which never finishes', async () => {
    const { speech } = await setup({ timeoutMs: 20 })
    await expect(speech.transcribe(new ReadableStream(), new AbortController().signal)).rejects.toThrow()
  })
  it('rejects backend failures and invalid output', async () => {
    const { speech } = await setup()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ bad: true })))
    await expect(speech.transcribe(new Response(wav()).body!, new AbortController().signal)).rejects.toThrow('invalid transcript')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    await expect(speech.transcribe(new Response(wav()).body!, new AbortController().signal)).rejects.toThrow('HTTP 500')
  })
})
