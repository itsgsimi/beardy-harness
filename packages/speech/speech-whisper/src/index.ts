/** Shared local transcription provider and authenticated binary audio intake. */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-client-connection'
import { collectBytes, decodeAudio } from './audio.ts'
import { installAttachmentSpeech } from './attachments.ts'

/** Deployment settings shared by every speech consumer. */
export interface Config {
  /** Private whisper.cpp multipart inference endpoint. */
  readonly endpoint: string
  /** FFmpeg executable available on the harness host. */
  readonly ffmpegPath: string
  /** Maximum encoded bytes accepted per transcription. */
  readonly maxAudioBytes: number
  /** Maximum decoded recording length in seconds. */
  readonly maxDurationSeconds: number
  /** Deadline in milliseconds for upload, decoding, and inference together. */
  readonly timeoutMs: number
  /** Maximum simultaneous transcriptions; excess requests fail promptly. */
  readonly maxConcurrent: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Local speech transcription for browser recordings and admitted gateway audio. */
    speech: SpeechWhisper
  }
}

/** Speech remains outside the model loop; consumers submit the resulting text normally. */
export class SpeechWhisper extends Service<Config> {
  static inject = ['subprocess']
  static Config: z<Config> = z.object({
    endpoint: z.string().required(), ffmpegPath: z.string().required(),
    maxAudioBytes: z.number().step(1).min(1).max(64 * 1024 * 1024).required(),
    maxDurationSeconds: z.number().step(1).min(1).max(600).required(),
    timeoutMs: z.number().step(1).min(1).max(600000).required(),
    maxConcurrent: z.number().step(1).min(1).max(8).required(),
  })
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<string>>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'speech')
    const endpoint = new URL(config.endpoint)
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
      throw new Error('speech: endpoint must be an HTTP URL without embedded credentials')
    }
    ctx.effect(() => async () => {
      this.lifetime.abort()
      await Promise.allSettled([...this.pending])
    })
    ctx.inject(['connection'], (c) => {
      c.effect(() => c.connection.fetch.register({
        path: '/api/speech', methods: ['POST'], requestBody: 'streaming',
        fetch: request => this.handleRequest(request),
      }))
    })
    ctx.inject(['connection'], (c) => {
      c.effect(() => c.connection.fetch.register({
        path: '/api/speech/config', methods: ['GET'], requestBody: 'buffered',
        fetch: request => this.handleRequest(request),
      }))
    })
    installAttachmentSpeech(ctx, this)
  }

  /** Maximum encoded recording size accepted from any source. */
  get maxAudioBytes(): number { return this.config.maxAudioBytes }
  /** Complete request deadline, also used by gateway downloads. */
  get timeoutMs(): number { return this.config.timeoutMs }

  /**
   * Transcribe bounded encoded audio with caller cancellation and provider shutdown.
   * @param data - encoded recording; ownership transfers to this call.
   * @param signal - caller cancellation, combined with the provider deadline and lifetime.
   * @returns trimmed recognized text, or an empty string when no speech is detected.
   */
  transcribe(data: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<string> {
    if (this.pending.size >= this.config.maxConcurrent) return Promise.reject(new Error('Speech transcription is busy; please retry'))
    const combined = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(this.config.timeoutMs)])
    const task = this.run(data, combined)
    this.pending.add(task)
    void task.finally(() => this.pending.delete(task)).catch(() => { /* The caller owns this rejection. */ })
    return task
  }

  private async run(data: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    const reader = data.getReader()
    const abort = (): void => { void reader.cancel(signal.reason).catch(() => { /* Stream already failed. */ }) }
    signal.addEventListener('abort', abort, { once: true })
    async function* chunks(): AsyncIterable<Uint8Array> {
      while (true) {
        const next = await reader.read()
        if (next.done) return
        yield next.value
      }
    }
    let bytes: Buffer
    try { bytes = await collectBytes(chunks(), this.config.maxAudioBytes) }
    finally {
      signal.removeEventListener('abort', abort)
      await reader.cancel().catch(() => { /* A failed upload has no remaining bytes. */ })
      reader.releaseLock()
    }
    signal.throwIfAborted()
    const wav = await decodeAudio(this.ctx.subprocess, bytes, this.config.ffmpegPath, this.config.maxDurationSeconds, signal)
    const form = new FormData()
    form.set('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'recording.wav')
    form.set('response_format', 'json')
    const response = await fetch(this.config.endpoint, { method: 'POST', body: form, signal, redirect: 'error' })
    if (!response.ok) throw new Error(`Speech backend returned HTTP ${response.status}`)
    if (response.body === null) throw new Error('Speech backend returned no result')
    const result: unknown = JSON.parse((await collectBytes(response.body, 1024 * 1024)).toString('utf8'))
    if (typeof result !== 'object' || result === null || !('text' in result) || typeof result.text !== 'string') {
      throw new Error('Speech backend returned an invalid transcript')
    }
    return result.text.trim()
  }

  private async handleRequest(request: Request): Promise<Response> {
    const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' }
    if (request.method === 'GET') return Response.json({
      maxAudioBytes: this.config.maxAudioBytes, maxDurationSeconds: this.config.maxDurationSeconds,
    }, { headers })
    if (request.body === null) return new Response('Audio is required', { status: 400 })
    const type = request.headers.get('content-type')?.split(';')[0]?.trim()
    if (!type?.startsWith('audio/') && type !== 'application/octet-stream') return new Response('Audio is required', { status: 415 })
    try {
      const text = await this.transcribe(request.body, request.signal)
      return Response.json({ text }, { headers })
    } catch (error) {
      this.ctx.logger.warn(`speech: ${String(error)}`)
      return Response.json({ error: 'Transcription failed. Check the recording length or try again.' }, { status: 422, headers })
    }
  }
}

export default SpeechWhisper
