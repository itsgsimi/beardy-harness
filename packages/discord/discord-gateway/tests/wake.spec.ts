import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createAfterScheduleRecord, createEveryScheduleRecord, ScheduleId } from '@deepseek-ai/dsh-schedule'
import { DiscordWakeCoordinator, dispatchLegacyReminders } from '../src/wake.ts'
import type { ConversationRecord } from '../src/domain.ts'
import { record, tableFromMap } from './support.ts'

const owners: DiscordWakeCoordinator[] = []
afterEach(async () => {
  await Promise.all(owners.splice(0).map(owner => owner.dispose()))
  vi.useRealTimers()
})

function reminder(seconds: number, seq = 0): SessionEvent {
  return { seq, type: 'schedule/change', data: { version: 1, operation: 'create',
    schedule: createAfterScheduleRecord(ScheduleId(`schedule-${String(seq)}`), 'reminder', seconds, Date.now(), 'Reminder'),
  } } as SessionEvent
}

function fixture(events: SessionEvent[] = [reminder(1)]) {
  const records = new Map([['channel', record({ channelId: 'channel' })]])
  const read = vi.fn(async () => ({ events }))
  const close = vi.fn(async () => {})
  const ctx = { logger: { warn: vi.fn() }, sessionPersistence: {
    open: vi.fn(async () => ({ read, close, inheritedEventCount: 0 })),
  } }
  const live = new Set<string>()
  const wake = vi.fn(async (value: ConversationRecord) => { live.add(value.channelId) })
  const table = tableFromMap(records)
  const owner = new DiscordWakeCoordinator(new Context().extend(ctx),
    table, wake, channel => live.has(channel), 1000)
  owners.push(owner)
  return { owner, read, close, ctx, records, live, wake }
}

describe('Discord cold reminder timers', () => {
  it('selects the earliest reminder, rechecks an early wall clock, and cancels replaced timers', async () => {
    vi.useFakeTimers()
    const h = fixture([reminder(3), reminder(1, 1)])
    const now = Date.now()
    await h.owner.start()
    await h.owner.refresh('channel')
    vi.setSystemTime(now - 1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.wake).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.wake).toHaveBeenCalledTimes(1)
    expect(h.close).toHaveBeenCalledTimes(3)
    await h.owner.refresh('channel')
    expect(h.read).toHaveBeenCalledTimes(3)
  })

  it('leaves empty, removed, live, and stopped conversations without cold timers', async () => {
    vi.useFakeTimers()
    const h = fixture([])
    await h.owner.start()
    await h.owner.refresh('missing')
    h.live.add('channel')
    await h.owner.refresh('channel')
    await h.owner.dispose()
    await h.owner.start()
    await vi.advanceTimersByTimeAsync(100000)
    expect(h.read).toHaveBeenCalledTimes(1)
    expect(h.wake).not.toHaveBeenCalled()
  })

  it('retries persistence and resume failures without starting a replacement session', async () => {
    vi.useFakeTimers()
    const h = fixture()
    h.read.mockRejectedValueOnce(new Error('disk busy'))
    h.wake.mockRejectedValueOnce(new Error('session still leased'))
    await h.owner.start()
    await vi.advanceTimersByTimeAsync(2002)
    expect(h.wake).toHaveBeenCalledTimes(2)
    expect(h.ctx.logger.warn).toHaveBeenCalledTimes(2)
    expect(h.records.get('channel')?.sessionId).toBe('discord-old-session')
  })

  it('does not arm a session whose conversation was replaced while its log was read', async () => {
    vi.useFakeTimers()
    const h = fixture()
    const waiting = Promise.withResolvers<{ events: SessionEvent[] }>()
    const started = Promise.withResolvers<undefined>()
    h.read.mockImplementationOnce(async () => { started.resolve(undefined); return waiting.promise })
    const refresh = h.owner.refresh('channel')
    await started.promise
    h.records.delete('channel')
    waiting.resolve({ events: [reminder(1)] })
    await refresh
    await vi.advanceTimersByTimeAsync(2000)
    expect(h.wake).not.toHaveBeenCalled()
  })

  it('waits for an aborted read to close and leaves no retry after disposal', async () => {
    vi.useFakeTimers()
    const h = fixture()
    const waiting = Promise.withResolvers<{ events: SessionEvent[] }>()
    const started = Promise.withResolvers<undefined>()
    h.read.mockImplementationOnce(async () => { started.resolve(undefined); return waiting.promise })
    const refresh = h.owner.refresh('channel')
    await started.promise
    const stop = h.owner.dispose()
    waiting.reject(new Error('read aborted'))
    await Promise.all([refresh, stop])
    expect(h.close).toHaveBeenCalledTimes(1)
    expect(h.ctx.logger.warn).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

/** Serve the in-memory Session as its persisted log through a read-only handle double. */
function persisted(session: Session) {
  const close = vi.fn(async () => {})
  return { close, sessionPersistence: { open: vi.fn(async () => ({
    read: async () => ({ events: session.ownEvents() }), close, inheritedEventCount: 0,
  })) } }
}

describe('legacy reminder dispatch', () => {
  it('does not flush a session without due reminders', async () => {
    const session = Session.create(SessionId('legacy-future'))
    session.append('schedule/change', { version: 1, operation: 'create',
      schedule: createAfterScheduleRecord(ScheduleId('future'), 'Later', 60, Date.now(), 'Later') })
    const flush = vi.fn(async () => true)
    const store = persisted(session)
    const ctx = new Context().extend({ sessions: { flush }, sessionPersistence: store.sessionPersistence })
    const followup = vi.fn()
    const agent: Pick<Agent, 'session' | 'followup'> = { session, followup }

    expect(await dispatchLegacyReminders(ctx, agent as Agent)).toBe(0)
    expect(followup).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
    expect(store.close).toHaveBeenCalledOnce()
  })

  it('frames historical untitled recurring reminders and requires a durable inbox splice', async () => {
    const session = Session.create(SessionId('legacy-recurring'))
    const old = createEveryScheduleRecord(ScheduleId('recurring'), 'Check in', 300,
      Date.now() - 600_000, 'Old title')
    const { title: _title, ...untitled } = old
    session.append('schedule/change', { version: 1, operation: 'create',
      schedule: untitled as typeof old })
    const flush = vi.fn(async () => false)
    const ctx = new Context().extend({ sessions: { flush }, sessionPersistence: persisted(session).sessionPersistence })
    const followup = vi.fn<Agent['followup']>()
    const agent: Pick<Agent, 'session' | 'followup'> = { session, followup }

    await expect(dispatchLegacyReminders(ctx, agent as Agent))
      .rejects.toThrow('Discord legacy reminder inbox was not persisted')
    expect(followup).toHaveBeenCalledOnce()
    expect(followup.mock.calls[0]?.[0].content.map(block => block.type === 'text' ? block.text : '').join(''))
      .toContain('Check in')
    expect(flush).toHaveBeenCalledWith(session)
    expect(session.ownEvents().some(event => event.type === 'schedule/change'
      && event.data.operation === 'dispatch' && Reflect.has(event.data, 'acceptedAt'))).toBe(true)
  })
})
