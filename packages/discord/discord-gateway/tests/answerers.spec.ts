/**
 * Behavior of the approval and question answerers: prompt text, reply matching, and the full
 * request lifecycle through the conversation router.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  approvalOutcomeForLine,
  approvalOutcomeForReaction,
  buildApprovalPrompt,
  buildQuestionPrompt,
  parseQuestionAnswer,
} from '../src/answerers.ts'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { CHANNEL, USER, drain, harness, inbound } from './support.ts'

function question(overrides: Partial<AskUserQuestionItem> = {}): AskUserQuestionItem {
  return { id: 'q1', question: 'Which color?', options: [{ label: 'Red' }, { label: 'Blue' }], ...overrides }
}

describe('approval reply matching', () => {
  it('maps the two emoji to the two one-shot outcomes', () => {
    expect(approvalOutcomeForReaction('✅')).toBe('allowed-once')
    expect(approvalOutcomeForReaction('❌')).toBe('rejected')
    expect(approvalOutcomeForReaction('👍')).toBeUndefined()
  })

  it('maps yes and no case-insensitively and nothing else', () => {
    expect(approvalOutcomeForLine('yes')).toBe('allowed-once')
    expect(approvalOutcomeForLine(' YES ')).toBe('allowed-once')
    expect(approvalOutcomeForLine('No')).toBe('rejected')
    expect(approvalOutcomeForLine('y')).toBeUndefined()
    expect(approvalOutcomeForLine('run it')).toBeUndefined()
  })
})

describe('prompt text', () => {
  it('names the tool, reason, both reply forms, and the expiry', () => {
    const text = buildApprovalPrompt('bash', 'rm -rf build/', ['reaction', 'text'], 600_000)
    expect(text).toContain('Approval needed — bash: rm -rf build/.')
    expect(text).toContain('React ✅ to allow once or ❌ to reject.')
    expect(text).toContain('Reply yes to allow once or no to reject.')
    expect(text).toContain('Expires in 10 min.')
  })

  it('omits forms the deployment disabled and the reason when absent', () => {
    const text = buildApprovalPrompt('write_file', '', ['reaction'], 30_000)
    expect(text).toBe('Approval needed — write_file. React ✅ to allow once or ❌ to reject. Expires in 1 min.')
  })

  it('asks one question with numbered options and a choice hint', () => {
    const text = buildQuestionPrompt(question({ detail: 'Pick the wall color.' }), 0, 1)
    expect(text).toContain('A question needs your answer: Which color?')
    expect(text).toContain('Pick the wall color.')
    expect(text).toContain('1. Red\n2. Blue')
    expect(text).toContain('Reply with the number of your choice.')
  })

  it('shows position, header, and the comma hint for multi-select', () => {
    const text = buildQuestionPrompt(question({ header: 'Colors', multiSelect: true }), 1, 3)
    expect(text).toContain('Question 2 of 3 — Colors: Which color?')
    expect(text).toContain('comma-separated (for example 1,3)')
  })

  it('asks for free text when the question carries no options', () => {
    const text = buildQuestionPrompt({ id: 'q1', question: 'What timezone?' }, 0, 1)
    expect(text).toContain('Reply with your answer.')
  })
})

describe('question reply matching', () => {
  it('selects an option label by number', () => {
    expect(parseQuestionAnswer(question(), '2')).toEqual({ id: 'q1', selected: ['Blue'] })
  })

  it('refuses numbers outside the list, labels, and multi-number replies to single-select', () => {
    expect(parseQuestionAnswer(question(), '0')).toBeUndefined()
    expect(parseQuestionAnswer(question(), '3')).toBeUndefined()
    expect(parseQuestionAnswer(question(), 'Red')).toBeUndefined()
    expect(parseQuestionAnswer(question(), '1,2')).toBeUndefined()
  })

  it('accepts a comma list for multi-select and refuses duplicates', () => {
    expect(parseQuestionAnswer(question({ multiSelect: true }), '1,')).toEqual({ id: 'q1', selected: ['Red'] })
    const three = question({ options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], multiSelect: true })
    expect(parseQuestionAnswer(three, '1,3')).toEqual({ id: 'q1', selected: ['A', 'C'] })
    expect(parseQuestionAnswer(three, '2,2')).toBeUndefined()
  })

  it('takes the whole line as free text when no options exist', () => {
    expect(parseQuestionAnswer(question({ options: [] }), 'Europe/Zagreb')).toEqual({
      id: 'q1', selected: [], custom: 'Europe/Zagreb',
    })
    expect(parseQuestionAnswer({ id: 'q1', question: 'tz' }, 'CET')).toEqual({
      id: 'q1', selected: [], custom: 'CET',
    })
    expect(parseQuestionAnswer(question({ options: [] }), '   ')).toBeUndefined()
  })

  it('refuses a line of nothing but separators', () => {
    expect(parseQuestionAnswer(question(), ',,')).toBeUndefined()
  })
})

describe('approval answerer through the router', () => {
  it('delegates a request from an Agent this listener does not own', async () => {
    const h = harness({ replyText: 'x' })
    let delegated = false
    const outcome = await h.emitWaterfall(
      'approval/request',
      { agent: { session: { id: 'other' } }, toolName: 'bash' },
      async () => { delegated = true; return 'unavailable' as never },
    )
    expect(delegated).toBe(true)
    expect(outcome).toBe('unavailable')
    expect(h.prompts).toHaveLength(0)
  })

  it('posts the prompt and grants once on ✅ from an allowlisted user', async () => {
    const h = harness({ replyText: 'x' })
    h.router.handle(inbound())
    await drain()
    const pending = h.emitWaterfall('approval/request', { agent: h.agent, toolName: 'bash', reason: 'rm -rf build/' })
    await drain()
    expect(h.prompts[0]?.content).toContain('Approval needed — bash: rm -rf build/.')
    h.router.handleReaction({ userId: USER, channelId: CHANNEL, messageId: 'prompt-1', emojiName: '✅' })
    await expect(pending).resolves.toBe('allowed-once')
  })

  it('ignores reactions from strangers and other messages, then rejects on ❌', async () => {
    const h = harness({ replyText: 'x' })
    h.router.handle(inbound())
    await drain()
    const pending = h.emitWaterfall('approval/request', { agent: h.agent, toolName: 'bash' })
    await drain()
    h.router.handleReaction({ userId: '999999999999999999', channelId: CHANNEL, messageId: 'prompt-1', emojiName: '✅' })
    h.router.handleReaction({ userId: USER, channelId: CHANNEL, messageId: 'other-message', emojiName: '✅' })
    h.router.handleReaction({ userId: USER, channelId: CHANNEL, messageId: 'prompt-1', emojiName: '👍' })
    await drain()
    h.router.handleReaction({ userId: USER, channelId: CHANNEL, messageId: 'prompt-1', emojiName: '❌' })
    await expect(pending).resolves.toBe('rejected')
  })

  it('answers from a yes text without starting a turn', async () => {
    const h = harness({ replyText: 'x' })
    h.router.handle(inbound())
    await drain()
    const pending = h.emitWaterfall('approval/request', { agent: h.agent, toolName: 'bash' })
    await drain()
    h.router.handle(inbound({ id: 'm2', content: 'maybe later' }))
    h.router.handle(inbound({ id: 'm3', content: 'no' }))
    await expect(pending).resolves.toBe('rejected')
    expect(h.calls.filter(call => call.startsWith('followup:'))).toHaveLength(1)
  })

  it('/stop names both the waiting request and the running turn', async () => {
    const h = harness({ replyText: 'x', hang: true, turnTimeoutMs: 5_000 })
    h.router.handle(inbound())
    await drain()
    const pending = h.emitWaterfall('approval/request', { agent: h.agent, toolName: 'bash' })
    await drain()
    h.router.handle(inbound({ id: 'm2', content: '/stop' }))
    await expect(pending).resolves.toBe('cancelled')
    expect(h.posted.some(entry => entry.content === 'Cancelled the waiting request and the running turn.')).toBe(true)
    expect(h.calls).toContain('cancel:{"kind":"user"}')
    h.releaseIdle()
  })

  it('ignores the asking abort once an answer settled the request', async () => {
    const h = harness({ replyText: 'x' })
    h.router.handle(inbound())
    await drain()
    const controller = new AbortController()
    const pending = h.emitWaterfall(
      'approval/request',
      { agent: h.agent, toolName: 'bash', signal: controller.signal },
    )
    await drain()
    h.router.handle(inbound({ id: 'm2', content: 'yes' }))
    await expect(pending).resolves.toBe('allowed-once')
    controller.abort()
    await drain()
  })

  it('cancels a waiting approval when the listener stops', async () => {
    const h = harness({ replyText: 'x' })
    h.router.handle(inbound())
    await drain()
    const pending = h.emitWaterfall('approval/request', { agent: h.agent, toolName: 'bash' })
    await drain()
    h.controller.abort()
    await expect(pending).resolves.toBe('cancelled')
  })

  it('ignores reactions when nothing waits or a question waits instead', async () => {
    const h = harness({ replyText: 'x' })
    h.router.handleReaction({ userId: USER, channelId: CHANNEL, messageId: 'prompt-1', emojiName: '✅' })
    h.router.handle(inbound())
    await drain()
    const pending = h.emitWaterfall('user-questions/request', { agent: h.agent, questions: [question()] })
    await drain()
    h.router.handleReaction({ userId: USER, channelId: CHANNEL, messageId: 'prompt-1', emojiName: '✅' })
    h.router.handle(inbound({ id: 'm2', content: '1' }))
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['Red'] }] })
  })

  it('delivers prompts through the Discord transport and matches the returned message id', async () => {
    vi.stubGlobal('fetch', async () => {
      return new Response(JSON.stringify({ id: 'px' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    })
    try {
      const h = harness({ replyText: 'x', useDefaultPrompt: true })
      h.router.handle(inbound())
      await drain()
      const pending = h.emitWaterfall('approval/request', { agent: h.agent, toolName: 'bash' })
      await drain()
      h.router.handleReaction({ userId: USER, channelId: CHANNEL, messageId: 'px', emojiName: '✅' })
      await expect(pending).resolves.toBe('allowed-once')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('still answers by text when the prompt reply carries no usable message id', async () => {
    vi.stubGlobal('fetch', async () => new Response('not json', { status: 200 }))
    try {
      const h = harness({ replyText: 'x', useDefaultPrompt: true })
      h.router.handle(inbound())
      await drain()
      const pending = h.emitWaterfall('approval/request', { agent: h.agent, toolName: 'bash' })
      await drain()
      h.router.handleReaction({ userId: USER, channelId: CHANNEL, messageId: '', emojiName: '✅' })
      h.router.handle(inbound({ id: 'm2', content: 'yes' }))
      await expect(pending).resolves.toBe('allowed-once')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('ignores a JSON prompt reply whose body names no string id', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    try {
      const h = harness({ replyText: 'x', useDefaultPrompt: true })
      h.router.handle(inbound())
      await drain()
      const pending = h.emitWaterfall('approval/request', { agent: h.agent, toolName: 'bash' })
      await drain()
      h.router.handle(inbound({ id: 'm2', content: 'no' }))
      await expect(pending).resolves.toBe('rejected')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports unavailable when the transport rejects the prompt', async () => {
    vi.stubGlobal('fetch', async () => new Response('forbidden', { status: 403 }))
    try {
      const h = harness({ replyText: 'x', useDefaultPrompt: true })
      h.router.handle(inbound())
      await drain()
      const pending = h.emitWaterfall('approval/request', { agent: h.agent, toolName: 'bash' })
      await expect(pending).resolves.toBe('unavailable')
      expect(h.warnings.some(message => message.includes('approval prompt'))).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('cancels on expiry and tells the channel', async () => {
    const h = harness({ replyText: 'x', approvalTimeoutMs: 30 })
    h.router.handle(inbound())
    await drain()
    const pending = h.emitWaterfall('approval/request', { agent: h.agent, toolName: 'bash' })
    await new Promise(resolve => setTimeout(resolve, 80))
    await expect(pending).resolves.toBe('cancelled')
    expect(h.posted.some(entry => entry.content.includes('expired'))).toBe(true)
  })

  it('cancels when the asking operation aborts', async () => {
    const h = harness({ replyText: 'x' })
    h.router.handle(inbound())
    await drain()
    const controller = new AbortController()
    const pending = h.emitWaterfall(
      'approval/request',
      { agent: h.agent, toolName: 'bash', signal: controller.signal },
    )
    await drain()
    controller.abort()
    await expect(pending).resolves.toBe('cancelled')
  })

  it('reports unavailable and warns when the prompt cannot be delivered', async () => {
    const h = harness({ replyText: 'x', failPrompt: true })
    h.router.handle(inbound())
    await drain()
    const pending = h.emitWaterfall('approval/request', { agent: h.agent, toolName: 'bash' })
    await expect(pending).resolves.toBe('unavailable')
    expect(h.warnings.some(message => message.includes('approval prompt'))).toBe(true)
  })

  it('/stop cancels the waiting request and /status names it', async () => {
    const h = harness({ replyText: 'x' })
    h.router.handle(inbound())
    await drain()
    const pending = h.emitWaterfall('approval/request', { agent: h.agent, toolName: 'bash' })
    await drain()
    h.router.handle(inbound({ id: 'm2', content: '/status' }))
    await drain()
    expect(h.posted.some(entry => entry.content.includes('Approval waiting for your answer.'))).toBe(true)
    h.router.handle(inbound({ id: 'm3', content: '/stop' }))
    await expect(pending).resolves.toBe('cancelled')
    expect(h.posted.some(entry => entry.content === 'Cancelled the waiting request.')).toBe(true)
  })

  it('cancels an older approval when a newer one arrives on the same channel', async () => {
    const h = harness({ replyText: 'x' })
    h.router.handle(inbound())
    await drain()
    const first = h.emitWaterfall('approval/request', { agent: h.agent, toolName: 'bash' })
    await drain()
    const second = h.emitWaterfall('approval/request', { agent: h.agent, toolName: 'write_file' })
    await drain()
    await expect(first).resolves.toBe('cancelled')
    h.router.handleReaction({ userId: USER, channelId: CHANNEL, messageId: 'prompt-1', emojiName: '✅' })
    await expect(second).resolves.toBe('allowed-once')
  })

  it('ignores reactions while the deployment accepts text only', async () => {
    const h = harness({ replyText: 'x', answerers: ['text'] })
    h.router.handle(inbound())
    await drain()
    const pending = h.emitWaterfall('approval/request', { agent: h.agent, toolName: 'bash' })
    await drain()
    h.router.handleReaction({ userId: USER, channelId: CHANNEL, messageId: 'prompt-1', emojiName: '✅' })
    await drain()
    h.router.handle(inbound({ id: 'm2', content: 'yes' }))
    await expect(pending).resolves.toBe('allowed-once')
  })

  it('ignores text answers while the deployment accepts reactions only', async () => {
    const h = harness({ replyText: 'x', answerers: ['reaction'] })
    h.router.handle(inbound())
    await drain()
    const pending = h.emitWaterfall('approval/request', { agent: h.agent, toolName: 'bash' })
    await drain()
    h.router.handle(inbound({ id: 'm2', content: 'yes' }))
    expect(h.calls.filter(call => call.startsWith('followup:'))).toHaveLength(1)
    h.router.handleReaction({ userId: USER, channelId: CHANNEL, messageId: 'prompt-1', emojiName: '❌' })
    await expect(pending).resolves.toBe('rejected')
  })

  it('releases the pending request when the conversation is released', async () => {
    const h = harness({ replyText: 'x' })
    h.router.handle(inbound())
    await drain()
    const pending = h.emitWaterfall('approval/request', { agent: h.agent, toolName: 'bash' })
    await drain()
    await h.router.dispose()
    await expect(pending).resolves.toBe('cancelled')
  })
})

describe('question answerer through the router', () => {
  it('delegates when no Agent is attached or this listener does not own it', async () => {
    const h = harness({ replyText: 'x' })
    let delegated = 0
    const next = async () => { delegated += 1; return { answers: [] } as never }
    await h.emitWaterfall('user-questions/request', { questions: [question()] }, next)
    await h.emitWaterfall(
      'user-questions/request',
      { agent: { session: { id: 'other' } }, questions: [question()] },
      next,
    )
    expect(delegated).toBe(2)
  })

  it('asks the question and answers by number without starting a turn', async () => {
    const h = harness({ replyText: 'x' })
    h.router.handle(inbound())
    await drain()
    const pending = h.emitWaterfall('user-questions/request', { agent: h.agent, questions: [question()] })
    await drain()
    expect(h.prompts[0]?.content).toContain('1. Red\n2. Blue')
    h.router.handle(inbound({ id: 'm2', content: '2' }))
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['Blue'] }] })
    expect(h.calls.filter(call => call.startsWith('followup:'))).toHaveLength(1)
  })

  it('keeps waiting through an invalid reply and takes the next valid one', async () => {
    const h = harness({ replyText: 'x' })
    h.router.handle(inbound())
    await drain()
    const pending = h.emitWaterfall('user-questions/request', { agent: h.agent, questions: [question()] })
    await drain()
    h.router.handle(inbound({ id: 'm2', content: '9' }))
    h.router.handle(inbound({ id: 'm3', content: '1' }))
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['Red'] }] })
  })

  it('walks two questions in order and returns both answers', async () => {
    const h = harness({ replyText: 'x' })
    h.router.handle(inbound())
    await drain()
    const second = question({ id: 'q2', question: 'And the finish?', options: [{ label: 'Matte' }] })
    const pending = h.emitWaterfall('user-questions/request', { agent: h.agent, questions: [question(), second] })
    await drain()
    h.router.handle(inbound({ id: 'm2', content: '2' }))
    await drain()
    expect(h.prompts[1]?.content).toContain('Question 2 of 2')
    h.router.handle(inbound({ id: 'm3', content: '1' }))
    await expect(pending).resolves.toEqual({
      answers: [{ id: 'q1', selected: ['Blue'] }, { id: 'q2', selected: ['Matte'] }],
    })
  })

  it('takes free text for a question without options', async () => {
    const h = harness({ replyText: 'x' })
    h.router.handle(inbound())
    await drain()
    const pending = h.emitWaterfall(
      'user-questions/request',
      { agent: h.agent, questions: [question({ options: [] })] },
    )
    await drain()
    h.router.handle(inbound({ id: 'm2', content: 'Europe/Zagreb' }))
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: [], custom: 'Europe/Zagreb' }] })
  })

  it('rejects with ASK_TIMEOUT on expiry and tells the channel', async () => {
    const h = harness({ replyText: 'x', questionTimeoutMs: 30 })
    h.router.handle(inbound())
    await drain()
    const pending = h.emitWaterfall('user-questions/request', { agent: h.agent, questions: [question()] })
    // Attach the rejection handler before the short timeout fires so nothing looks unhandled.
    const assertion = expect(pending).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_TIMEOUT' })
    await new Promise(resolve => setTimeout(resolve, 80))
    await assertion
    expect(h.posted.some(entry => entry.content.includes('expired'))).toBe(true)
  })

  it('/status names a waiting question', async () => {
    const h = harness({ replyText: 'x' })
    h.router.handle(inbound())
    await drain()
    h.emitWaterfall('user-questions/request', { agent: h.agent, questions: [question()] })
    await drain()
    h.router.handle(inbound({ id: 'm2', content: '/status' }))
    await drain()
    expect(h.posted.some(entry => entry.content.includes('Question waiting for your answer.'))).toBe(true)
  })

  it('ignores an abort after the answers settled the request', async () => {
    const h = harness({ replyText: 'x' })
    h.router.handle(inbound())
    await drain()
    const controller = new AbortController()
    const pending = h.emitWaterfall(
      'user-questions/request',
      { agent: h.agent, questions: [question()], signal: controller.signal },
    )
    await drain()
    h.router.handle(inbound({ id: 'm2', content: '1' }))
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['Red'] }] })
    controller.abort()
    await drain()
  })

  it('rejects with ASK_ABORTED when the asking operation aborts', async () => {
    const h = harness({ replyText: 'x' })
    h.router.handle(inbound())
    await drain()
    const controller = new AbortController()
    const pending = h.emitWaterfall(
      'user-questions/request',
      { agent: h.agent, questions: [question()], signal: controller.signal },
    )
    await drain()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_ABORTED' })
  })

  it('rejects a waiting question when the listener stops', async () => {
    const h = harness({ replyText: 'x' })
    h.router.handle(inbound())
    await drain()
    const pending = h.emitWaterfall('user-questions/request', { agent: h.agent, questions: [question()] })
    await drain()
    h.controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_ABORTED' })
  })

  it('/stop rejects the waiting question with ASK_ABORTED', async () => {
    const h = harness({ replyText: 'x' })
    h.router.handle(inbound())
    await drain()
    const pending = h.emitWaterfall('user-questions/request', { agent: h.agent, questions: [question()] })
    await drain()
    h.router.handle(inbound({ id: 'm2', content: '/stop' }))
    await expect(pending).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_ABORTED' })
  })

  it('reports ASK_UNAVAILABLE when the question prompt cannot be delivered', async () => {
    const h = harness({ replyText: 'x', failPrompt: true })
    h.router.handle(inbound())
    await drain()
    const pending = h.emitWaterfall('user-questions/request', { agent: h.agent, questions: [question()] })
    await expect(pending).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_UNAVAILABLE' })
  })
})
