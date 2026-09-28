import { afterEach, describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SignalTarget } from '@deepseek-ai/dsh-signal'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { outboxRecord, SignalOutbox, storedImage } from '../src/outbox.ts'
import type { OutboxRecord, OutboxSettings } from '../src/outbox.ts'
import { SignalRpcError } from '../src/rpc.ts'
import { until } from './support.ts'

const GROUP = `signal:group:${Buffer.alloc(32, 8).toString('base64')}`
const NUMBER = 'signal:number:+15551234567'
const IMAGE: ImageAttachmentRef = { attachmentId: AttachmentId('sha256:frame'), mediaType: 'image/jpeg', bytes: 3, width: 2, height: 2 }

class MemoryTable implements KvTable<string, OutboxRecord> {
  readonly rows = new Map<string, OutboxRecord>()
  failPuts = 0
  get size(): number { return this.rows.size }
  get(key: string): OutboxRecord | undefined { return this.rows.get(key) }
  entries(): IterableIterator<[string, OutboxRecord]> { return new Map(this.rows).entries() }
  keys(): IterableIterator<string> { return new Map(this.rows).keys() }
  async update(key: string, fn: (current: OutboxRecord) => OutboxRecord): Promise<OutboxRecord> {
    const next = fn(this.rows.get(key) as OutboxRecord)
    await this.put(key, next)
    return next
  }
  async put(key: string, value: OutboxRecord): Promise<void> {
    if (this.failPuts > 0) {
      this.failPuts--
      throw new Error('disk full')
    }
    this.rows.set(key, outboxRecord.parse(value))
  }
  async delete(key: string): Promise<boolean> { return this.rows.delete(key) }
}

interface Sent { readonly target: SignalTarget; readonly part: string; readonly image?: ImageAttachmentRef }

const SETTINGS: OutboxSettings = { maxPending: 3, retryMs: 10, maxRetryMs: 25, maxAttempts: 4, maxReceipts: 2 }
const outboxes: SignalOutbox[] = []

afterEach(async () => { for (const outbox of outboxes.splice(0)) await outbox.dispose() })

function setup(send: (sent: Sent) => Promise<void> = async () => {}, settings: Partial<OutboxSettings> = {}) {
  const table = new MemoryTable()
  const sent: Sent[] = []
  const logs: string[] = []
  const outbox = new SignalOutbox(table, { ...SETTINGS, ...settings }, async (target, part, image) => {
    const entry = { target, part, ...image === undefined ? {} : { image } }
    await send(entry)
    sent.push(entry)
  }, { warn: (line) => { logs.push(`warn: ${line}`) }, error: (line) => { logs.push(`error: ${line}`) } })
  outboxes.push(outbox)
  return { table, sent, logs, outbox }
}

describe('SignalOutbox', () => {
  it('persists before sending, sends the image with the first part only, and keeps a receipt', async () => {
    const { table, sent, outbox } = setup()
    await expect(outbox.enqueue('d1', GROUP, ['one', 'two'], IMAGE)).resolves.toBe('queued')
    expect(table.rows.get('d1')).toMatchObject({ target: GROUP, parts: ['one', 'two'], cursor: 0, ordinal: 1, attempts: 0, image: IMAGE })
    expect(outbox.pending()).toBe(1)
    await until(() => table.rows.get('d1')?.completedAt !== undefined)
    expect(sent).toEqual([
      { target: { transport: 'signal', kind: 'group', groupId: GROUP.slice('signal:group:'.length) }, part: 'one', image: IMAGE },
      { target: { transport: 'signal', kind: 'group', groupId: GROUP.slice('signal:group:'.length) }, part: 'two' },
    ])
    expect(table.rows.get('d1')).toMatchObject({ parts: [], cursor: 0 })
    expect(table.rows.get('d1')).not.toHaveProperty('image')
    expect(outbox.pending()).toBe(0)
    await expect(outbox.enqueue('d1', GROUP, ['again'], undefined)).resolves.toBe('duplicate')
  })

  it('refuses a full queue and a stopping queue', async () => {
    const hold = Promise.withResolvers<undefined>()
    const { outbox } = setup(() => hold.promise, { maxPending: 1 })
    await outbox.enqueue('a', NUMBER, ['x'], undefined)
    await expect(outbox.enqueue('b', NUMBER, ['y'], undefined)).rejects.toThrow('Signal outbox is full')
    hold.resolve(undefined)
    await outbox.dispose()
    await expect(outbox.enqueue('c', NUMBER, ['z'], undefined)).rejects.toThrow('Signal outbox is stopping')
  })

  it('retries a failed part from its checkpoint with a doubling delay, holding later deliveries to the same target', async () => {
    let failures = 2
    const { table, sent, logs, outbox } = setup(async ({ part }) => {
      if (part === 'two' && failures-- > 0) throw new Error('daemon down')
    })
    await outbox.enqueue('first', GROUP, ['one', 'two'], undefined)
    await outbox.enqueue('second', GROUP, ['three'], undefined)
    await outbox.enqueue('other', NUMBER, ['elsewhere'], undefined)
    await until(() => table.rows.get('second')?.completedAt !== undefined)
    expect(sent.map(entry => entry.part)).toEqual(['one', 'elsewhere', 'two', 'three'])
    expect(logs).toEqual([
      'warn: signal-cli: delivery first stays queued; retrying in 10 ms: daemon down',
      'warn: signal-cli: delivery first stays queued; retrying in 20 ms: daemon down',
    ])
    expect(table.rows.get('first')).toMatchObject({ attempts: 2 })
    expect([...table.rows.keys()].sort()).toEqual(['first', 'second'])
  })

  it('abandons a delivery on a permanent failure and after its attempt limit', async () => {
    const { table, logs, outbox } = setup(async ({ part }) => {
      if (part === 'bad') throw new SignalRpcError(-1, 'Invalid group id', true)
      throw new Error('offline')
    }, { maxAttempts: 2 })
    await outbox.enqueue('bad', GROUP, ['bad'], undefined)
    await outbox.enqueue('flaky', NUMBER, ['flaky'], undefined)
    await until(() => table.rows.get('flaky')?.completedAt !== undefined)
    expect(table.rows.get('bad')).toMatchObject({ attempts: 1, abandoned: 'permanent failure: signal-cli error -1: Invalid group id', parts: [] })
    expect(table.rows.get('flaky')).toMatchObject({ attempts: 2, abandoned: '2 failed attempts: offline' })
    expect(logs).toEqual([
      'error: signal-cli: delivery bad abandoned after permanent failure: signal-cli error -1: Invalid group id',
      'warn: signal-cli: delivery flaky stays queued; retrying in 10 ms: offline',
      'error: signal-cli: delivery flaky abandoned after 2 failed attempts: offline',
    ])
  })

  it('resumes persisted deliveries on start and reports a persistence failure', async () => {
    const { table, sent, logs, outbox } = setup()
    table.rows.set('old', { target: NUMBER, parts: ['a', 'b'], cursor: 1, ordinal: 4, createdAt: 1, nextAttemptAt: 1, attempts: 0 })
    table.failPuts = 2
    outbox.start()
    await until(() => logs.length > 0)
    expect(logs).toEqual(['warn: signal-cli: outbox persistence failed: disk full'])
    await until(() => table.rows.get('old')?.completedAt !== undefined)
    expect(sent.map(entry => entry.part)).toEqual(['b', 'b'])
    await outbox.enqueue('next', NUMBER, ['c'], undefined)
    expect(table.rows.get('next')?.ordinal).toBe(5)
  })

  it('arms nothing without pending deliveries and stops mid-drain on disposal', async () => {
    const hold = Promise.withResolvers<undefined>()
    const started = Promise.withResolvers<undefined>()
    const { table, sent, outbox } = setup(async ({ part }) => {
      if (part !== 'a') return
      started.resolve(undefined)
      await hold.promise
    })
    outbox.start()
    await outbox.enqueue('one', GROUP, ['a'], undefined)
    await outbox.enqueue('two', NUMBER, ['b'], undefined)
    await started.promise
    expect(outbox.pending()).toBe(2)
    const disposing = outbox.dispose()
    hold.resolve(undefined)
    await disposing
    expect(sent.map(entry => entry.part)).toEqual(['a'])
    expect(table.rows.get('two')?.completedAt).toBeUndefined()
  })
})

describe('storedImage', () => {
  it('rebuilds the typed reference with optional fields', () => {
    expect(storedImage(undefined)).toBeUndefined()
    const full = { ...IMAGE, name: 'f.jpg', originalDimensions: { width: 9, height: 9 } }
    expect(storedImage(full)).toEqual(full)
  })
})
