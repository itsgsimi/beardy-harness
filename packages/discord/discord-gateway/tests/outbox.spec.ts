import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { DiscordMessageBody } from '@deepseek-ai/dsh-tool-discord'
import { DiscordOutbox } from '../src/outbox.ts'
import { outboxRecord } from '../src/domain.ts'
import type { OutboxRecord } from '../src/domain.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { CHANNEL, harness, record } from './support.ts'

const settings = { outboxMaxPending: 2, outboxMaxChars: 5000, outboxRetryMs: 1000,
  outboxMaxRetryMs: 8000, outboxMaxReceipts: 2 }
const owners: DiscordOutbox[] = []
afterEach(async () => {
  await Promise.all(owners.splice(0).map(owner => owner.dispose()))
  vi.useRealTimers()
})

function table() {
  const records = new Map<string, OutboxRecord>()
  const storage = {
    get: (id: string) => records.get(id), entries: () => records.entries(),
    put: vi.fn(async (id: string, record: OutboxRecord) => { records.set(id, outboxRecord.parse(record)) }),
    delete: async (id: string) => records.delete(id),
  } as unknown as KvTable<string, OutboxRecord>
  return { records, storage }
}

function owner(storage: KvTable<string, OutboxRecord>, post: (channel: string, text: string | DiscordMessageBody) => Promise<void>) {
  const result = new DiscordOutbox(storage, settings, post, vi.fn())
  owners.push(result)
  return result
}

describe('durable Discord outbox', () => {
  it('preserves same-millisecond enqueue order when restart loads records in another order', async () => {
    vi.useFakeTimers()
    const { storage, records } = table()
    const sent: (string | DiscordMessageBody)[] = []
    const first = owner(storage, async (_channel, text) => { sent.push(text) })
    await first.enqueue('z', 'c', 'first')
    await first.enqueue('a', 'c', 'second')
    expect(records.get('z')?.createdAt).toBe(records.get('a')?.createdAt)
    await first.dispose()
    const reversed = [...records.entries()].reverse()
    records.clear()
    for (const [key, value] of reversed) records.set(key, value)
    const second = owner(storage, async (_channel, text) => { sent.push(text) })
    second.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual(['first', 'second'])
  })

  it('rejects a malformed durable cursor instead of accepting an unusable record', () => {
    expect(outboxRecord.safeParse({ channelId: 'c', chunks: ['one'], cursor: 2,
      ordinal: 1, createdAt: 0, nextAttemptAt: 0, attempts: 0 }).success).toBe(false)
  })

  it('backs off after a storage failure and bounds retained receipts', async () => {
    vi.useFakeTimers()
    const { storage, records } = table()
    const post = vi.fn(async () => {})
    const queue = owner(storage, post)
    await queue.enqueue('a', 'c', 'a')
    vi.spyOn(storage, 'put').mockRejectedValueOnce(new Error('disk unavailable'))
      .mockRejectedValueOnce(new Error('disk unavailable'))
    await vi.advanceTimersByTimeAsync(999)
    expect(post).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(post).toHaveBeenCalledTimes(2)
    for (const id of ['b', 'd']) {
      await queue.enqueue(id, 'c', id)
      await vi.advanceTimersByTimeAsync(1)
    }
    expect(records.has('d')).toBe(true)
    expect(records.size).toBe(2)
    expect(queue.pending('c')).toBe(0)
    await queue.dispose()
    await expect(queue.enqueue('late', 'c', 'late')).rejects.toThrow('stopping')
  })

  it('defers future retry records while another channel delivers', async () => {
    vi.useFakeTimers()
    const { records, storage } = table()
    records.set('future', { channelId: 'later', chunks: ['later'], cursor: 0, attempts: 1,
      ordinal: 1, createdAt: Date.now() - 1, nextAttemptAt: Date.now() + 1000 })
    const post = vi.fn(async () => {})
    const queue = owner(storage, post)
    await queue.enqueue('now', 'current', 'now')
    expect(queue.pending('later')).toBe(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(post).toHaveBeenCalledExactlyOnceWith('current', 'now')
  })

  it.each(['next-record', 'next-chunk', 'failed-post'])('stops at %s without losing unacknowledged work', async (mode) => {
    vi.useFakeTimers()
    const { records, storage } = table()
    const pending = Promise.withResolvers<undefined>()
    const started = Promise.withResolvers<undefined>()
    const queue = owner(storage, async () => { started.resolve(undefined); await pending.promise })
    await queue.enqueue('first', 'c', mode === 'next-chunk' ? 'x'.repeat(2001) : 'first')
    if (mode === 'next-record') await queue.enqueue('second', 'c', 'second')
    vi.advanceTimersByTime(0)
    await started.promise
    const stopping = queue.dispose()
    if (mode === 'failed-post') pending.reject(new Error('transport aborted'))
    else pending.resolve(undefined)
    await stopping
    if (mode === 'next-record') expect(records.get('second')?.cursor).toBe(0)
    else expect(records.get('first')).toMatchObject({ cursor: mode === 'next-chunk' ? 1 : 0, attempts: 0 })
  })
  it('retains turn A after a full queue and later recovers A and B separately, excluding an unfinished turn', async () => {
    vi.useFakeTimers()
    const { records, storage } = table()
    for (let i = 0; i < 100; i++) records.set(`occupied-${String(i)}`, {
      channelId: 'offline', chunks: ['occupied'], cursor: 0, attempts: 0,
      ordinal: i + 1, createdAt: Date.now(), nextAttemptAt: Date.now() + 100000,
    })
    const events = [{ seq: 0, type: 'assistant/message', data: {
      turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Turn A done.' }] },
    } }, { seq: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }] as unknown as SessionEvent[]
    const h = harness({ outboxStorage: storage, storedEvents: events,
      initialRecord: record({ deliveredThrough: 0 }), manualWait: true })
    try {
      await h.router.recover()
      expect(h.table.records.get(CHANNEL)?.deliveredThrough).toBe(0)
      events.push({ seq: 2, type: 'turn/start', data: { turn: 2 } } as SessionEvent,
        { seq: 3, type: 'assistant/message', data: { turn: 2, step: 1,
          message: { content: [{ type: 'text', text: 'Turn B done.' }] } } } as SessionEvent,
        { seq: 4, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } } as SessionEvent,
        { seq: 5, type: 'turn/start', data: { turn: 3 } } as SessionEvent,
        { seq: 6, type: 'assistant/message', data: { turn: 3, step: 1,
          message: { content: [{ type: 'text', text: 'Still working.' }] } } } as SessionEvent,
        { seq: 7, type: 'step/end', data: { turn: 3, step: 1 } } as SessionEvent)
      records.clear()
      await h.router.recover()
      await vi.advanceTimersByTimeAsync(0)
      expect(h.posted.map(post => post.content)).toEqual(['Turn A done.', 'Turn B done.'])
      expect(h.table.records.get(CHANNEL)?.deliveredThrough).toBe(5)
      expect(h.calls.some(call => call.startsWith('agent-resume:'))).toBe(false)
    } finally {
      await h.router.dispose()
    }
  })
  it('recovers a committed final reply without resuming or rerunning its agent', async () => {
    vi.useFakeTimers()
    const { storage } = table()
    const events = [{ seq: 0, type: 'assistant/message', data: {
      turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Work completed.' }] },
    } }, { seq: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }] as unknown as SessionEvent[]
    const h = harness({ outboxStorage: storage, storedEvents: events,
      initialRecord: record({ deliveredThrough: 0 }), manualWait: true })
    try {
      await h.router.recover()
      await vi.advanceTimersByTimeAsync(0)
      expect(h.posted.map(post => post.content)).toEqual(['Work completed.'])
      expect(h.calls).not.toContain('agent-create')
      expect(h.calls.some(call => call.startsWith('agent-resume:'))).toBe(false)
      expect(h.table.records.get(CHANNEL)?.deliveredThrough).toBe(2)
      await h.router.recover()
      await vi.advanceTimersByTimeAsync(0)
      expect(h.posted).toHaveLength(1)
    } finally {
      h.controller.abort()
      await h.router.dispose()
    }
  })
  it('persists before posting, retries a failed chunk after restart, and suppresses repeated delivery ids', async () => {
    vi.useFakeTimers()
    const { records, storage } = table()
    const sent: (string | DiscordMessageBody)[] = []
    const first = owner(storage, async (_channel, text) => {
      expect(records.has('run-1')).toBe(true)
      if (sent.length === 1) throw new Error('network unavailable')
      sent.push(text)
    })
    await first.enqueue('run-1', 'channel', 'a'.repeat(2000) + 'tail')
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual(['a'.repeat(2000)])
    expect(records.get('run-1')).toMatchObject({ cursor: 1, attempts: 1, nextAttemptAt: Date.now() + 1000 })
    await first.dispose()

    const second = owner(storage, async (_channel, text) => { sent.push(text) })
    second.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(sent).toEqual(['a'.repeat(2000), 'tail'])
    expect(records.get('run-1')?.completedAt).toBeDefined()
    await second.enqueue('run-1', 'channel', 'duplicate')
    await vi.advanceTimersByTimeAsync(1000)
    expect(sent).toHaveLength(2)
  })

  it('bounds whole deliveries and queue capacity before any post', async () => {
    vi.useFakeTimers()
    const { records, storage } = table()
    const post = vi.fn(async () => {})
    const queue = owner(storage, post)
    await expect(queue.enqueue('too-large', 'c', 'x'.repeat(5001))).rejects.toThrow('characters')
    await queue.enqueue('one', 'c', 'one')
    await queue.enqueue('two', 'c', 'two')
    await expect(queue.enqueue('three', 'c', 'three')).rejects.toThrow('full')
    expect(records.size).toBe(2)
    expect(post).not.toHaveBeenCalled()
  })

  it('preserves channel order during retry without blocking other channels', async () => {
    vi.useFakeTimers()
    const { storage } = table()
    const post = vi.fn(async (channel: string) => { if (channel === 'offline') throw new Error('offline') })
    const queue = new DiscordOutbox(storage, { ...settings, outboxMaxPending: 3 }, post, vi.fn())
    owners.push(queue)
    await queue.enqueue('a', 'offline', 'first')
    await queue.enqueue('b', 'offline', 'second')
    await queue.enqueue('c', 'online', 'third')
    await vi.advanceTimersByTimeAsync(999)
    expect(post.mock.calls.map(([channel]) => channel)).toEqual(['offline', 'online'])
    await vi.advanceTimersByTimeAsync(1)
    expect(post.mock.calls.map(([channel]) => channel)).toEqual(['offline', 'online', 'offline'])
  })

  it('waits for an owned in-flight post during disposal and leaves its progress recoverable', async () => {
    vi.useFakeTimers()
    const { records, storage } = table()
    const posted = Promise.withResolvers<undefined>()
    const started = Promise.withResolvers<undefined>()
    const queue = owner(storage, async () => { started.resolve(undefined); await posted.promise })
    await queue.enqueue('one', 'c', 'one')
    vi.advanceTimersByTime(0)
    await started.promise
    let disposed = false
    const stop = queue.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    posted.resolve(undefined)
    await stop
    expect(records.get('one')?.completedAt).toBeDefined()
  })

  it('persists complete cards and controls and resumes only unacknowledged bodies after restart', async () => {
    vi.useFakeTimers()
    const { records, storage } = table()
    const cards: DiscordMessageBody[] = [{ content: '', embeds: [{ title: 'Status', description: '**Ready**' }] }, {
      content: 'Choose an action',
      components: [{ type: 1, components: [{ type: 2, style: 1, custom_id: 'continue', label: 'Continue' }] }],
    }]
    const sent: (string | DiscordMessageBody)[] = []
    const first = owner(storage, async (_channel, body) => {
      expect(records.get('cards')?.chunks).toEqual(cards)
      if (sent.length === 1) throw new Error('disconnected')
      sent.push(body)
    })
    await first.enqueue('cards', 'channel', cards)
    expect(sent).toEqual([])
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual([cards[0]])
    expect(records.get('cards')?.cursor).toBe(1)
    await first.dispose()
    const second = owner(storage, async (_channel, body) => { sent.push(body) })
    second.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(sent).toEqual(cards)
    expect(records.get('cards')).toMatchObject({ chunks: [], cursor: 0, completedAt: Date.now() })
  })

  it('sends legacy text chunks unchanged instead of applying current Markdown conversion', async () => {
    vi.useFakeTimers()
    const { records, storage } = table()
    const text = '| Name | Status |\n| --- | --- |\n| A | complete |'
    records.set('old', outboxRecord.parse({ channelId: 'c', chunks: [text], cursor: 0, ordinal: 1,
      attempts: 0, createdAt: Date.now(), nextAttemptAt: Date.now() }))
    const post = vi.fn(async () => {})
    const queue = owner(storage, post)
    queue.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(post).toHaveBeenCalledExactlyOnceWith('c', text)
  })

  it('bounds serialized rich deliveries and validates every body before persisting', async () => {
    vi.useFakeTimers()
    const { records, storage } = table()
    const post = vi.fn(async () => {})
    const queue = owner(storage, post)
    await expect(queue.enqueue('empty', 'c', [])).rejects.toThrow('characters')
    await expect(queue.enqueue('invalid', 'c', [{ content: 'valid' }, { content: '', embeds: [{}] }])).rejects.toThrow('visible text')
    const rich = { content: 'x'.repeat(1000), embeds: [{ description: 'y'.repeat(3960) }] }
    expect(rich.content.length + rich.embeds[0]!.description.length).toBeLessThan(5000)
    await expect(queue.enqueue('oversized', 'c', [rich])).rejects.toThrow('characters')
    expect(records.size).toBe(0)
    expect(post).not.toHaveBeenCalled()
  })
})
