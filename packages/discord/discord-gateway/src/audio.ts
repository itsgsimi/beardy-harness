/** Audio admission is owned by the router; this module only resolves admitted CDN attachments. */
import type { SpeechWhisper } from '@deepseek-ai/dsh-speech-whisper'
import type { DiscordInboundMessage } from './types.ts'

/** Transcribe admitted attachments without forwarding credentials or following CDN redirects. */
export async function transcribeDiscordAudio(
  message: DiscordInboundMessage, speech: SpeechWhisper, signal: AbortSignal,
): Promise<DiscordInboundMessage> {
  const parts = [message.content]
  let total = 0
  for (const attachment of message.audioAttachments ?? []) {
    const url = new URL(attachment.url)
    if (url.protocol !== 'https:' || url.username || url.password || url.port !== ''
      || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)
      || !url.pathname.startsWith('/attachments/')) throw new Error('Unsupported Discord audio URL')
    total += attachment.size
    if (!Number.isFinite(attachment.size) || attachment.size < 0 || total > speech.maxAudioBytes) {
      throw new Error('Discord audio exceeds the configured limit')
    }
    const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(speech.timeoutMs)])
    const response = await fetch(url, { signal: downloadSignal, redirect: 'error' })
    if (!response.ok || response.body === null) throw new Error('Could not download the Discord recording')
    const text = await speech.transcribe(response.body, downloadSignal)
    if (text === '') throw new Error('No speech detected in the Discord recording')
    parts.push(`Voice transcript:\n${text}`)
  }
  return { ...message, content: parts.filter(Boolean).join('\n\n') }
}
