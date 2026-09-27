import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { afterEach, expect, it, vi } from 'vitest'
import { installAttachmentSpeech } from '../src/attachments.ts'
import { SpeechWhisper } from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

it('adds an audio transcript to the canonical message while preserving its file and source', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('attachments', { async *readFileStream() { yield new Uint8Array([1, 2, 3]) } })
  const speechCtx = new Context()
  contexts.push(speechCtx)
  const speech = new SpeechWhisper(speechCtx, {
    endpoint: 'http://127.0.0.1:1', ffmpegPath: 'ffmpeg', maxAudioBytes: 10,
    maxDurationSeconds: 60, timeoutMs: 1000, maxConcurrent: 1,
  })
  const transcribe = vi.spyOn(speech, 'transcribe').mockResolvedValue('Please inspect the build.')
  installAttachmentSpeech(ctx, speech)
  await new Promise(resolve => setTimeout(resolve, 0))
  const message = createUserMessage({ content: [{ type: 'file', attachment: {
    attachmentId: 'test' as AttachmentId, name: 'voice.ogg', bytes: 3,
  } }], source: { kind: 'user' } })
  const agentId = SessionId('voice')
  const agent: Agent = {
    ctx, id: agentId, session: Session.create(agentId), options: {}, status: 'idle',
    inbox: {
      nextTurn: [], nextStep: [], clear: () => {}, append: () => {}, prepend: () => {},
      replace: () => false, remove: () => false, splice: () => [],
    },
    cancel: () => {}, whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal),
    send: () => {}, followup: () => {}, steer: () => {}, inject: () => {},
  }
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
})
