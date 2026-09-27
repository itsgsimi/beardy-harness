import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { HealthMonitor } from '@deepseek-ai/dsh-health'
import { ScheduleId, createAfterScheduleRecord } from '@deepseek-ai/dsh-schedule'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { OutboxRecord } from '../src/domain.ts'
import { attachCronDelivery } from '../src/conversation.ts'
import { CHANNEL, USER, assistantTextEvent, harness, inbound, record, tableFromMap, turnEndEvent, turnStartEvent } from './support.ts'

const harnesses: ReturnType<typeof harness>[] = []
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(h => h.router.dispose()))
  vi.useRealTimers()
})

function durable(options: Parameters<typeof harness>[0] = {}) {
  const values = new Map<string, OutboxRecord>()
  const table = tableFromMap(values)
  const h = harness({ ...options, outboxStorage: table, manualWait: true })
  harnesses.push(h)
  return { h, values, table }
}

function finish(events: SessionEvent[], text: string, reason: 'completed' | 'interrupted' = 'completed'): void {
  events.push(turnStartEvent(events.length, 2))
  events.push(assistantTextEvent(events.length, 2, text))
  events.push(turnEndEvent(events.length, 2, { kind: reason }))
}

function reminderEvent(id: string): SessionEvent<'schedule/change'> {
  return {
    seq: SessionSeq(0), time: Date.now(), type: 'schedule/change',
    data: { version: 1, operation: 'create',
      schedule: createAfterScheduleRecord(ScheduleId(id), 'Check the build', 1, Date.now(), 'Check the build') },
  }
}

describe('durable Discord conversation delivery', () => {
  it('queues exactly one down and one recovered notice across a local HTTP outage', async () => {
    const { h, values } = durable()
    const listen = async (port: number): Promise<Server> => await new Promise((resolve, reject) => {
      const server = createServer((_request, response) => { response.writeHead(200); response.end() })
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server) })
    })
    const close = async (server: Server): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    }
    let server: Server | undefined = await listen(0)
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('HTTP fixture needs an allocated TCP port')
    const port = address.port
    const monitor = new HealthMonitor({ probes: [{ name: 'model', url: `http://127.0.0.1:${String(port)}/models` }],
      intervalMs: 1000, timeoutMs: 1000, failureThreshold: 1, recoveryThreshold: 1,
      noticeChannelId: CHANNEL, noticeCooldownMs: 900_000 }, {
      fetch: globalThis.fetch, resolveCredential: async () => undefined, now: Date.now,
      deliver: async (transition) => { await h.router.deliver(transition.channelId, transition.text, transition.id); return true },
    })
    try {
      await monitor.check()
      expect(monitor.snapshot().probes[0]?.state).toBe('healthy')
      await close(server)
      server = undefined
      await monitor.check()
      await monitor.check()
      await vi.waitFor(() => { expect(h.posted).toHaveLength(1) })
      server = await listen(port)
      await monitor.check()
      await monitor.check()
      await vi.waitFor(() => { expect(h.posted).toHaveLength(2) })
      expect(h.posted.map(post => post.content)).toEqual([
        'Probe model: down (connection failed or timed out).', 'Probe model: recovered.',
      ])
      expect(values.size).toBe(2)
    } finally {
      await monitor.dispose()
      if (server !== undefined) await close(server)
    }
  })
  it('deduplicates a retried failed cron outcome in the existing outbox', async () => {
    const { h, values } = durable()
    attachCronDelivery(h.ctx, h.router)
    const run = { jobName: 'brief', sessionId: 'cron-1', firedAt: 1, outcome: 'failed',
      text: '', reportOutcome: true, deliverChannelId: CHANNEL,
      failure: { code: 'TRANSPORT', message: 'private' }, nextFireAt: '2026-09-28T07:00:00.000Z' }
    h.emitEvent('cron/run-finished', run)
    h.emitEvent('cron/run-finished', run)
    await vi.waitFor(() => { expect(h.posted).toHaveLength(1) })
    expect(values.size).toBe(1)
    expect(h.posted[0]?.content).toContain('brief" failed (TRANSPORT). Session: cron-1.')
  })
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
    const replacement = record({ sessionId: 'replacement', deliveredThrough: 10, lastInboundAt: 1 })
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
    const events: SessionEvent[] = [reminderEvent('reminder')]
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

  it('leaves a removed user lane dormant when its old reminder fires', async () => {
    vi.useFakeTimers()
    const events: SessionEvent[] = [reminderEvent('removed-lane-reminder')]
    const { h } = durable({ storedEvents: events, initialRecord: record({ lane: USER, deliveredThrough: 1 }) })
    await h.router.recover()
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.calls).not.toContain('agent-resume:discord-old-session')
    expect(h.warnings.some(message => message.includes('names removed lane'))).toBe(true)
    expect(h.table.records.get(CHANNEL)?.lane).toBe(USER)
  })

  it('supports a router without persistent delivery storage', async () => {
    const h = harness({ manualWait: true })
    harnesses.push(h)
    await expect(h.router.recover()).resolves.toBeUndefined()
  })

  it.each(['replaced', 'inbound', 'running', 'resume-error'] as const)(
    'rechecks conversation ownership and activity for a cold wake: %s', async (mode) => {
      vi.useFakeTimers()
      const events: SessionEvent[] = [reminderEvent('reminder')]
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
