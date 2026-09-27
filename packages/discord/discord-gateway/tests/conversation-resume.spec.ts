import { describe, expect, it } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { CHANNEL, drain, harness, inbound, record } from './support.ts'

describe('durable conversation records', () => {
  it('inherits the default route and effort for a new conversation', async () => {
    const h = harness({ defaultSelection: {
      provider: 'default', model: 'model', reasoningEffort: ReasoningEffortId('high'),
    } })
    h.router.handle(inbound())
    await drain()
    expect(h.selections[0]).toEqual({ provider: 'default', model: 'model', reasoningEffort: 'high' })
  })

  it('uses the configured Discord choice for a new conversation', async () => {
    const h = harness({ modelSelection: {
      provider: 'lane', model: 'model', reasoningEffort: ReasoningEffortId('medium'),
    } })
    h.router.handle(inbound())
    await drain()
    expect(h.selections[0]).toEqual({ provider: 'lane', model: 'model', reasoningEffort: 'medium' })
  })

  it('leaves the shared Web default selection untouched by a Discord override', async () => {
    const webChoice = { provider: 'web', model: 'chosen', reasoningEffort: ReasoningEffortId('high') }
    const h = harness({ defaultSelection: webChoice, modelSelection: {
      provider: 'discord', model: 'fast', reasoningEffort: ReasoningEffortId('medium'),
    } })
    h.router.handle(inbound())
    await drain()
    expect(h.selections[0]).toMatchObject({ provider: 'discord', model: 'fast', reasoningEffort: 'medium' })
    expect(h.ctx.agentDefaultModel.currentSelection()).toEqual(webChoice)
  })

  it('resumes with the last logged selection after the lane choice changes', async () => {
    const h = harness({ initialRecord: record(), modelSelection: {
      provider: 'new', model: 'new-model', reasoningEffort: ReasoningEffortId('low'),
    }, storedEvents: [{
      type: 'request/header', seq: SessionSeq(1), time: 1,
      data: { reason: 'initial', header: { config: {
        provider: 'old', model: 'old-model', reasoningEffort: ReasoningEffortId('medium'),
      } } },
    }] })
    h.router.handle(inbound())
    await drain()
    expect(h.selections[0]).toEqual({ provider: 'old', model: 'old-model', reasoningEffort: 'medium' })
  })

  it('resumes the recorded session instead of creating a new one', async () => {
    const h = harness({ replyText: 'continuing', initialRecord: record() })
    h.router.handle(inbound())
    await drain()
    expect(h.calls).toContain('agent-resume:discord-old-session')
    expect(h.calls).not.toContain('agent-create')
    expect(h.calls.some(call => call.startsWith('title:'))).toBe(false)
    expect(h.calls).toContain('followup:is the build green?')
    expect(h.posted[0]?.content).toBe('continuing')
  })

  it('mounts the configured preset and commands on the resumed agent', async () => {
    const h = harness({ replyText: 'ok', initialRecord: record() })
    h.router.handle(inbound())
    await drain()
    expect(h.calls).toContain('mount:beardy')
    expect(h.registeredCommands.has('new')).toBe(true)
    expect(h.registeredCommands.has('status')).toBe(true)
    expect(h.registeredCommands.has('stop')).toBe(true)
  })

  it('starts fresh and replaces the record when the logged session is gone', async () => {
    const h = harness({ replyText: 'fresh start', initialRecord: record(), resumeError: 'not-found' })
    h.router.handle(inbound())
    await drain()
    expect(h.warnings.some(message => message.includes('has no durable log anymore'))).toBe(true)
    expect(h.calls.filter(call => call === 'agent-create')).toHaveLength(1)
    const stored = h.table.records.get(CHANNEL)
    expect(stored?.sessionId).not.toBe('discord-old-session')
    expect(h.posted[0]?.content).toBe('fresh start')
  })

  it('reports a resume failure that is not a missing log without creating over it', async () => {
    const h = harness({ replyText: 'x', initialRecord: record(), resumeError: 'other' })
    h.router.handle(inbound())
    await drain()
    expect(h.warnings.some(message => message.includes('message m1 failed'))).toBe(true)
    expect(h.calls).not.toContain('agent-create')
    expect(h.table.records.get(CHANNEL)?.sessionId).toBe('discord-old-session')
  })

  it('replaces an expired conversation with a fresh session on the next message', async () => {
    const stale = record({ lastInboundAt: Date.now() - 10_000 })
    const h = harness({ replyText: 'new topic', initialRecord: stale, conversationMaxAgeMs: 50 })
    h.router.handle(inbound())
    await drain()
    expect(h.calls).not.toContain('agent-resume:discord-old-session')
    expect(h.calls.filter(call => call === 'agent-create')).toHaveLength(1)
    expect(h.table.records.get(CHANNEL)?.sessionId).not.toBe('discord-old-session')
  })

  it('stamps the record with each inbound arrival', async () => {
    const before = Date.now()
    const h = harness({ replyText: 'ok' })
    h.router.handle(inbound())
    await drain()
    const stored = h.table.records.get(CHANNEL)
    expect(stored).toBeDefined()
    expect(stored?.lastInboundAt).toBeGreaterThanOrEqual(before)
    expect(stored?.openedAt).toBeLessThanOrEqual(stored?.lastInboundAt ?? 0)
  })
})
