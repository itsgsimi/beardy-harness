import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { ScheduleId, createAfterScheduleRecord } from '@deepseek-ai/dsh-schedule'
import type { OutboxRecord } from '../src/domain.ts'
import { CHANNEL, harness, inbound, record } from './support.ts'

const harnesses: ReturnType<typeof harness>[] = []
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(h => h.router.dispose()))
  vi.useRealTimers()
})

function durable(options: Parameters<typeof harness>[0] = {}) {
  const values = new Map<string, OutboxRecord>()
  const table = {
    get: (key: string) => values.get(key), entries: () => values.entries(),
    put: async (key: string, value: OutboxRecord) => { values.set(key, value) },
    delete: async (key: string) => values.delete(key),
  } as unknown as KvTable<string, OutboxRecord>
  const h = harness({ ...options, outboxStorage: table, manualWait: true })
  harnesses.push(h)
  return { h, values, table }
}

function finish(events: SessionEvent[], text: string, reason = 'completed'): void {
  events.push({ seq: events.length, type: 'turn/start', data: { turn: 2 } } as SessionEvent)
  events.push({ seq: events.length, type: 'assistant/message', data: { turn: 2, step: 1,
    message: { content: [{ type: 'text', text }] } } } as SessionEvent)
  events.push({ seq: events.length, type: 'turn/end', data: { turn: 2, reason: { kind: reason } } } as SessionEvent)
}

describe('durable Discord conversation delivery', () => {
  it('queues ordinary, proactive, and status replies through the same outbox', async () => {
    const { h, values } = durable({ replyText: 'First answer.' })
    h.router.handle(inbound())
    await vi.waitFor(() => { expect(h.posted).toHaveLength(1) })
    finish(h.events, 'Proactive answer.')
    h.emitStatus(h.agent, 'idle')
    await vi.waitFor(() => { expect(h.posted).toHaveLength(2) })
    h.router.handle(inbound({ content: '/status' }))
    await vi.waitFor(() => { expect(h.posted).toHaveLength(3) })
    expect(h.posted[2]?.content).toContain('Queued deliveries: 0')
    await h.router.deliver(CHANNEL, 'Separate notice.')
    await vi.waitFor(() => { expect(h.posted).toHaveLength(4) })
    expect([...values.values()].every(item => item.completedAt !== undefined)).toBe(true)
  })

  it('retains failed posts in the outbox and reports retry diagnostics', async () => {
    vi.useFakeTimers()
    const { h, values } = durable({ replyText: 'Answer.', failPost: true })
    h.router.handle(inbound())
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.warnings.some(message => message.includes('remains queued'))).toBe(true)
    expect([...values.values()]).toMatchObject([{ cursor: 0, attempts: 1 }])
    expect(h.table.records.get(CHANNEL)?.deliveredThrough).toBe(3)
  })

  it('does not overwrite replacement routing metadata after an old reply is enqueued', async () => {
    const { h, values, table } = durable({ replyText: 'Old session answer.' })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(table, 'put').mockImplementationOnce(async (key, value) => {
      values.set(key, value)
      entered.resolve(undefined)
      await release.promise
    })
    h.router.handle(inbound())
    await entered.promise
    const replacement = record({ sessionId: 'replacement', deliveredThrough: 10 })
    h.table.records.set(CHANNEL, replacement)
    release.resolve(undefined)
    await vi.waitFor(() => { expect(h.posted).toHaveLength(1) })
    expect(h.table.records.get(CHANNEL)).toEqual(replacement)
  })

  it('leaves a failed durability checkpoint eligible for a later idle scan', async () => {
    const { h } = durable({ replyText: 'Answer.' })
    h.router.handle(inbound())
    await vi.waitFor(() => { expect(h.posted).toHaveLength(1) })
    const previous = h.table.records.get(CHANNEL)?.deliveredThrough
    vi.spyOn(h.ctx.sessions, 'flush').mockResolvedValueOnce(false)
    finish(h.events, 'Retained answer.')
    h.emitStatus(h.agent, 'idle')
    await vi.waitFor(() => { expect(h.warnings.some(message => message.includes('final reply remains'))).toBe(true) })
    expect(h.table.records.get(CHANNEL)?.deliveredThrough).toBe(previous)
    h.emitStatus(h.agent, 'idle')
    await vi.waitFor(() => { expect(h.posted).toHaveLength(2) })
  })

  it('recovers metadata-only old records without replaying historical or failed-turn text', async () => {
    const events: SessionEvent[] = []
    finish(events, 'Old answer.')
    const { h } = durable({ storedEvents: events, initialRecord: record() })
    await h.router.recover()
    expect(h.table.records.get(CHANNEL)?.deliveredThrough).toBe(3)
    finish(events, 'Partial failure.', 'interrupted')
    await h.router.recover()
    expect(h.table.records.get(CHANNEL)?.deliveredThrough).toBe(6)
    expect(h.posted).toEqual([])
  })

  it('wakes a persisted reminder in its recorded conversation and allows idle cleanup to re-arm it', async () => {
    vi.useFakeTimers()
    const events = [{ seq: 0, type: 'schedule/change', data: { version: 1, operation: 'create',
      schedule: createAfterScheduleRecord(ScheduleId('reminder'), 'Check the build', 1, Date.now()),
    } }] as unknown as SessionEvent[]
    const { h } = durable({ storedEvents: events, initialRecord: record({ deliveredThrough: 1 }) })
    await h.router.recover()
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.calls).toContain('agent-resume:discord-old-session')
    expect(h.calls).not.toContain('agent-create')
    finish(events, 'Reminder result.')
    h.emitStatus(h.agent, 'idle')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.posted.map(post => post.content)).toEqual(['Reminder result.'])
    h.waitResolvers.at(-1)!()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.handle.dispose).toHaveBeenCalledTimes(1)
  })

  it('supports a router without persistent delivery storage', async () => {
    const h = harness({ manualWait: true })
    harnesses.push(h)
    await expect(h.router.recover()).resolves.toBeUndefined()
  })

  it.each(['replaced', 'inbound', 'running', 'resume-error'] as const)(
    'rechecks conversation ownership and activity for a cold wake: %s', async (mode) => {
      vi.useFakeTimers()
      const events = [{ seq: 0, type: 'schedule/change', data: { version: 1, operation: 'create',
        schedule: createAfterScheduleRecord(ScheduleId('reminder'), 'Check the build', 1, Date.now()),
      } }] as unknown as SessionEvent[]
      const { h } = durable({ storedEvents: events, initialRecord: record({ deliveredThrough: 1 }),
        ...(mode === 'resume-error' ? { resumeError: 'other' } : {}) })
      await h.router.recover()
      if (mode === 'replaced') h.table.records.set(CHANNEL, record({ sessionId: 'replacement' }))
      if (mode === 'running') h.agent.status = 'running'
      if (mode === 'inbound') h.router.handle(inbound())
      vi.advanceTimersByTime(1000)
      await vi.advanceTimersByTimeAsync(0)
      if (mode === 'replaced') expect(h.calls).not.toContain('agent-resume:discord-old-session')
      else expect(h.calls.filter(call => call === 'agent-resume:discord-old-session')).toHaveLength(1)
      if (mode === 'resume-error') expect(h.warnings.some(message => message.includes('will retry'))).toBe(true)
      expect(h.posted).toEqual([])
    },
  )
})
