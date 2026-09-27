import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { afterEach, expect, it, vi } from 'vitest'
import { installAttachmentSpeech } from '../src/attachments.ts'
import { SpeechWhisper } from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function setup(readFileStream: () => AsyncIterable<Uint8Array>) {
  const ctx = new Context()
  contexts.push(ctx)
  const read = vi.fn(readFileStream)
  ctx.provide('attachments', { readFileStream: read })
  const speechCtx = new Context()
  contexts.push(speechCtx)
  const speech = new SpeechWhisper(speechCtx, {
    endpoint: 'http://127.0.0.1:1', ffmpegPath: 'ffmpeg', maxAudioBytes: 10,
    maxDurationSeconds: 60, timeoutMs: 1000, maxConcurrent: 1,
  })
  installAttachmentSpeech(ctx, speech)
  // Sibling inject fibers load in creation order, so this one settling means the speech listener is registered.
  await ctx.inject(['attachments'], () => {})
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
  const preStep = (message: UserMessage, decision: PreStepDecision = { kind: 'enter', messages: [message] }) =>
    agentEvents(ctx, agent).waterfall('agent/pre-step', {
      messages: [message], turn: 1, step: 1, signal: new AbortController().signal,
    }, async () => decision)
  return { speech, read, preStep }
}

function fileMessage(name: string, bytes = 3, extra: ContentBlock[] = []): UserMessage {
  return createUserMessage({ content: [...extra, { type: 'file', attachment: {
    attachmentId: 'test' as AttachmentId, name, bytes,
  } }], source: { kind: 'user' } })
}

it('adds an audio transcript to the canonical message while preserving its file and source', async () => {
  const { speech, preStep } = await setup(async function* () { yield new Uint8Array([1, 2, 3]) })
  const transcribe = vi.spyOn(speech, 'transcribe').mockResolvedValue('Please inspect the build.')
  const message = fileMessage('voice.ogg')
  const decision = await preStep(message)
  expect(decision.kind).toBe('enter')
  if (decision.kind !== 'enter') throw new Error('Expected admitted voice message')
  expect(decision.messages[0]).toMatchObject({ id: message.id, source: message.source })
  expect(decision.messages[0]?.content).toEqual([
    message.content[0], { type: 'text', text: 'Voice transcript for voice.ogg:\nPlease inspect the build.' },
  ])
  expect(transcribe).toHaveBeenCalledOnce()
})

it('streams every stored attachment chunk to transcription and ends the stream after the last one', async () => {
  const { speech, preStep } = await setup(async function* () {
    yield new Uint8Array([1, 2])
    yield new Uint8Array([3])
  })
  vi.spyOn(speech, 'transcribe').mockImplementation(async (stream) => {
    return [...new Uint8Array(await new Response(stream).arrayBuffer())].join(',')
  })
  const decision = await preStep(fileMessage('memo.WAV'))
  if (decision.kind !== 'enter') throw new Error('Expected admitted voice message')
  expect(decision.messages[0]?.content[1]).toEqual({ type: 'text', text: 'Voice transcript for memo.WAV:\n1,2,3' })
})

it('releases the stored attachment stream when transcription stops reading early', async () => {
  let released = false
  const { speech, preStep } = await setup(async function* () {
    try {
      yield new Uint8Array([1])
      yield new Uint8Array([2])
      yield new Uint8Array([3])
    } finally {
      released = true
    }
  })
  vi.spyOn(speech, 'transcribe').mockImplementation(async (stream) => {
    const reader = stream.getReader()
    const first = await reader.read()
    await reader.cancel()
    return String(first.value?.[0])
  })
  const decision = await preStep(fileMessage('voice.mp3'))
  if (decision.kind !== 'enter') throw new Error('Expected admitted voice message')
  expect(decision.messages[0]?.content[1]).toEqual({ type: 'text', text: 'Voice transcript for voice.mp3:\n1' })
  expect(released).toBe(true)
})

it('passes a rejected step and non-audio content through without transcription', async () => {
  const { speech, read, preStep } = await setup(async function* () { yield new Uint8Array([1]) })
  const transcribe = vi.spyOn(speech, 'transcribe')
  const audio = fileMessage('voice.ogg')
  await expect(preStep(audio, { kind: 'reject' })).resolves.toEqual({ kind: 'reject' })
  const document = fileMessage('notes.txt', 3, [{ type: 'text', text: 'See attached.' }])
  const decision = await preStep(document)
  if (decision.kind !== 'enter') throw new Error('Expected admitted document message')
  expect(decision.messages[0]?.content).toEqual(document.content)
  expect(transcribe).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
})

it('refuses an oversized audio attachment before reading it', async () => {
  const { speech, read, preStep } = await setup(async function* () { yield new Uint8Array([1]) })
  const transcribe = vi.spyOn(speech, 'transcribe')
  await expect(preStep(fileMessage('voice.ogg', 11))).rejects.toThrow('Audio attachment exceeds the configured limit')
  expect(read).not.toHaveBeenCalled()
  expect(transcribe).not.toHaveBeenCalled()
})

it('refuses an audio attachment in which no speech is detected', async () => {
  const { speech, preStep } = await setup(async function* () { yield new Uint8Array([1]) })
  vi.spyOn(speech, 'transcribe').mockResolvedValue('')
  await expect(preStep(fileMessage('silence.opus'))).rejects.toThrow('No speech detected in the audio attachment')
})
