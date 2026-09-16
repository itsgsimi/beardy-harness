/** Ordinary audio file uploads enter the same logged user message as their transcript. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SpeechWhisper } from './index.ts'

/** Register the standard file-attachment consumer for any input transport. */
export function installAttachmentSpeech(ctx: Context, speech: SpeechWhisper): void {
  ctx.inject(['attachments'], (c) => {
    c.on('agent/pre-step', async ({ signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      const messages = []
      for (const message of decision.messages) {
        const content: ContentBlock[] = []
        for (const block of message.content) {
          content.push(block)
          if (block.type !== 'file' || !/\.(ogg|oga|opus|mp3|m4a|wav|flac|webm|aac)$/i.test(block.attachment.name)) continue
          if (block.attachment.bytes > speech.maxAudioBytes) throw new Error('Audio attachment exceeds the configured limit')
          const iterator = c.attachments.readFileStream(block.attachment, signal)[Symbol.asyncIterator]()
          const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              const value = await iterator.next()
              if (value.done) controller.close()
              else controller.enqueue(value.value)
            },
            async cancel() { await iterator.return?.() },
          })
          const text = await speech.transcribe(stream, signal)
          if (text === '') throw new Error('No speech detected in the audio attachment')
          content.push({ type: 'text', text: `Voice transcript for ${block.attachment.name}:\n${text}` })
        }
        messages.push({ ...message, content })
      }
      return { ...decision, messages }
    })
  })
}
