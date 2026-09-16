import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { expect, it, vi } from 'vitest'
import { installAttachmentSpeech } from '../src/attachments.ts'
import type { SpeechWhisper } from '../src/index.ts'

it('adds an audio transcript to the canonical message while preserving its file and source', async () => {
  const ctx = new Context()
  ctx.provide('attachments', { async *readFileStream() { yield new Uint8Array([1, 2, 3]) } })
  const transcribe = vi.fn(async () => 'Please inspect the build.')
  installAttachmentSpeech(ctx, { maxAudioBytes: 10, transcribe } as unknown as SpeechWhisper)
  await new Promise(resolve => setTimeout(resolve, 0))
  const message = createUserMessage({ content: [{ type: 'file', attachment: {
    attachmentId: 'test' as AttachmentId, name: 'voice.ogg', bytes: 3,
  } }], source: { kind: 'user' } })
  const agent = { ctx, id: 'voice', session: {} } as unknown as Agent
  const decision = await agentEvents(ctx, agent).waterfall('agent/pre-step', {
    messages: [message], turn: 1, step: 1, signal: new AbortController().signal,
  }, async () => ({ kind: 'enter' as const, messages: [message] }))
  expect(decision.kind).toBe('enter')
  if (decision.kind !== 'enter') throw new Error('Expected admitted voice message')
  expect(decision.messages[0]).toMatchObject({ id: message.id, source: message.source })
  expect(decision.messages[0]?.content).toEqual([
    message.content[0], { type: 'text', text: 'Voice transcript for voice.ogg:\nPlease inspect the build.' },
  ])
  expect(transcribe).toHaveBeenCalledOnce()
  await ctx.fiber.dispose()
})
