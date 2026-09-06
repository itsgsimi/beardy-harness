import { describe, expect, it } from 'vitest'
import { CHANNEL, drain, harness, inbound } from './support.ts'

describe('proactive delivery', () => {
  it('posts the final text of a turn the router did not start', async () => {
    const h = harness({ replyText: 'answer', typingIndicator: false })
    h.router.handle(inbound())
    await drain()
    expect(h.posted).toHaveLength(1)

    // A reminder-like wake-up commits its own assistant message and settles.
    h.events.push({
      seq: h.events.length,
      type: 'assistant/message',
      data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'Time to stretch.' }] } },
    } as never)
    h.emitStatus(h.agent, 'idle')
    await drain()
    expect(h.posted[1]).toEqual({ content: 'Time to stretch.', channelId: CHANNEL, token: 'tok' })
  })

  it('posts each settled proactive turn once and never reposts settled text', async () => {
    const h = harness({ replyText: 'answer' })
    h.router.handle(inbound())
    await drain()
    h.events.push({
      seq: h.events.length,
      type: 'assistant/message',
      data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'Notice one.' }] } },
    } as never)
    h.emitStatus(h.agent, 'idle')
    await drain()
    h.emitStatus(h.agent, 'idle')
    h.emitStatus(h.agent, 'idle')
    await drain()
    expect(h.posted.map(entry => entry.content)).toEqual(['answer', 'Notice one.'])
  })

  it('does not double-post the reply of a turn the router is awaiting', async () => {
    const h = harness({ replyText: 'single post', hang: true, turnTimeoutMs: 5_000 })
    h.router.handle(inbound())
    await drain()
    // The agent committed its answer but has not gone idle yet; the listener must stay silent
    // because the awaited inbound turn owns this reply.
    h.emitStatus(h.agent, 'idle')
    await drain()
    expect(h.posted).toHaveLength(0)
    h.releaseIdle()
    await drain()
    expect(h.posted.map(entry => entry.content)).toEqual(['single post'])
  })

  it('stays silent for agents that belong to no conversation', async () => {
    const h = harness({ replyText: 'answer' })
    h.router.handle(inbound())
    await drain()
    h.emitStatus({ session: { seq: 0, ownEvents: () => [] } }, 'idle')
    await drain()
    expect(h.posted).toHaveLength(1)
  })

  it('posts nothing when a proactive turn produced no text', async () => {
    const h = harness({ replyText: 'answer' })
    h.router.handle(inbound())
    await drain()
    h.emitStatus(h.agent, 'idle')
    await drain()
    expect(h.posted).toHaveLength(1)
  })

  it('ignores non-idle status changes', async () => {
    const h = harness({ replyText: 'answer' })
    h.router.handle(inbound())
    await drain()
    h.emitStatus(h.agent, 'running')
    await drain()
    expect(h.posted).toHaveLength(1)
  })

  it('reports a proactive delivery that failed without wedging the conversation', async () => {
    const h = harness({ replyText: 'answer', failPost: true })
    h.router.handle(inbound())
    await drain()
    h.events.push({
      seq: h.events.length,
      type: 'assistant/message',
      data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'lost notice' }] } },
    } as never)
    h.emitStatus(h.agent, 'idle')
    await drain()
    expect(h.warnings.some(message => message.includes('reply to channel'))).toBe(true)
    // The floor advanced even though delivery failed; the settled text is not retried.
    h.emitStatus(h.agent, 'idle')
    await drain()
    expect(h.warnings.filter(message => message.includes('reply to channel'))).toHaveLength(2)
  })
})
