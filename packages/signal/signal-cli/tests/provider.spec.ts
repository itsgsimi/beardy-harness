import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { SignalDeliveryId, SignalGroupId, SignalNumber } from '@deepseek-ai/dsh-signal'
import type { SignalInboundMessage, SignalTarget } from '@deepseek-ai/dsh-signal'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import SignalCliService, { sendParams } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { fakeDaemon, until } from './support.ts'
import type { FakeDaemon } from './support.ts'

const GROUP_ID = Buffer.alloc(32, 9).toString('base64')
const GROUP: SignalTarget = { transport: 'signal', kind: 'group', groupId: SignalGroupId(GROUP_ID) }
const PERSON: SignalTarget = { transport: 'signal', kind: 'number', number: SignalNumber('+15551234567') }
const IMAGE: ImageAttachmentRef = { attachmentId: AttachmentId('sha256:frame'), mediaType: 'image/jpeg', bytes: 3, width: 2, height: 2, name: 'front door;1.jpeg' }

interface Harness {
  readonly ctx: Context
  readonly daemon: FakeDaemon
  readonly logs: { type: string; text: string }[]
  readonly service: SignalCliService
}

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function harness(config: Partial<Config> = {}, options: { attachments?: 'ok' | 'broken' | 'none'; before?: (daemon: FakeDaemon) => void } = {}): Promise<Harness> {
  const daemon = await fakeDaemon()
  options.before?.(daemon)
  const root = await mkdtemp(join(tmpdir(), 'dsh-signal-cli-'))
  const ctx = new Context()
  cleanups.push(
    async () => { await daemon.close() },
    async () => { await rm(root, { recursive: true, force: true }) },
    async () => { await ctx.fiber.dispose() },
  )
  const logs: { type: string; text: string }[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logs.push({ type: message.type, text: message.args.map(String).join(' ') }) } })
  await ctx.plugin(Storage)
  await ctx.plugin(storageJson, { root: join(root, 'storage') })
  await ctx.plugin(storageDomain, { backend: 'json' })
  if (options.attachments !== 'none') {
    ctx.provide('attachments', {
      readImage: async () => {
        if (options.attachments === 'broken') throw new Error('missing object')
        return { data: new Uint8Array([1, 2, 3]) }
      },
    } as never)
  }
  await ctx.plugin(SignalCliService, {
    baseUrl: daemon.baseUrl, requestTimeoutMs: 300, reconnectDelayMs: 10, maxReconnectDelayMs: 20,
    outboxRetryMs: 10, outboxMaxRetryMs: 20, ...config,
  })
  await until(() => ctx.get('signal') !== undefined)
  return { ctx, daemon, logs, service: ctx.signal as SignalCliService }
}

const sends = (daemon: FakeDaemon) => daemon.calls.filter(call => call.method === 'send').map(call => call.params)

describe('SignalCliService', () => {
  it('logs the connected account masked and sends bold text to a group', async () => {
    const h = await harness()
    await until(() => h.logs.some(log => log.text.startsWith('signal-cli: connected')))
    expect(h.logs).toContainEqual({ type: 'info', text: 'signal-cli: connected as +*********34' })
    await expect(h.service.send({ id: SignalDeliveryId('camera:ring-1'), target: GROUP, text: '**Front door** · 07:15: Doorbell rang' }))
      .resolves.toEqual({ id: 'camera:ring-1', state: 'queued' })
    await until(() => sends(h.daemon).length === 1)
    expect(sends(h.daemon)).toEqual([{ groupId: GROUP_ID, message: 'Front door · 07:15: Doorbell rang', textStyle: ['0:10:BOLD'] }])
    await expect(h.service.send({ id: SignalDeliveryId('camera:ring-1'), target: GROUP, text: 'again' })).resolves.toEqual({ id: 'camera:ring-1', state: 'duplicate' })
    let health = await h.service.health()
    while (health.pending > 0) health = await new Promise(resolve => setTimeout(resolve, 5)).then(() => h.service.health())
    expect(health).toMatchObject({ reachable: true, account: '+*********34', pending: 0 })
  })

  it('attaches a stored image as a data URI to the first part and splits long text', async () => {
    const h = await harness({ maxMessageChars: 100 })
    const text = `${'a'.repeat(80)} ${'b'.repeat(80)}`
    const { id } = await h.service.send({ target: PERSON, text, image: IMAGE })
    expect(id).toMatch(/^[0-9a-f-]{36}$/u)
    await until(() => sends(h.daemon).length === 2)
    expect(sends(h.daemon)).toEqual([
      { recipient: ['+15551234567'], message: 'a'.repeat(80), attachments: ['data:image/jpeg;filename=front_door_1.jpg;base64,AQID'] },
      { recipient: ['+15551234567'], message: 'b'.repeat(80) },
    ])
    const { name: _name, ...unnamed } = IMAGE
    await h.service.send({ target: PERSON, text: 'png', image: { ...unnamed, mediaType: 'image/png' } })
    await until(() => sends(h.daemon).length === 3)
    expect(sends(h.daemon)[2]).toMatchObject({ attachments: ['data:image/png;filename=image.png;base64,AQID'] })
  })

  it('sends text only when the image is unreadable or no attachment store is mounted', async () => {
    const broken = await harness({}, { attachments: 'broken' })
    const { name: _name, ...unnamed } = IMAGE
    await broken.service.send({ target: GROUP, text: 'x', image: { ...unnamed, mediaType: 'image/png' } })
    await until(() => sends(broken.daemon).length === 1)
    expect(sends(broken.daemon)[0]).not.toHaveProperty('attachments')
    expect(broken.logs.map(log => log.text)).toContain('signal-cli: stored image sha256:frame is unreadable; sending text only: missing object')
    const none = await harness({ account: '+15550001234' }, { attachments: 'none' })
    await none.service.send({ target: GROUP, text: 'y', image: IMAGE })
    await until(() => sends(none.daemon).length === 1)
    expect(sends(none.daemon)[0]).toEqual({ account: '+15550001234', groupId: GROUP_ID, message: 'y' })
    expect(none.logs.map(log => log.text)).toContain('signal-cli: no attachment store is mounted; sending text only')
  })

  it('rejects empty and oversized text', async () => {
    const h = await harness({ outboxMaxChars: 10, receive: false })
    await expect(h.service.send({ target: GROUP, text: '   ' })).rejects.toThrow('Signal delivery has no visible text')
    await expect(h.service.send({ target: GROUP, text: 'x'.repeat(11) })).rejects.toThrow('Signal delivery text exceeds 10 characters')
  })

  it('logs loudly and keeps deliveries queued while the daemon is unreachable', async () => {
    const h = await harness({ receive: false }, { before: (daemon) => { daemon.checkStatus = 503 } })
    await until(() => h.logs.some(log => log.type === 'error'))
    expect(h.logs).toContainEqual({ type: 'error', text: `signal-cli: daemon at ${h.daemon.baseUrl} is unreachable (liveness check answered HTTP 503); deliveries stay queued and retry until it answers` })
    await expect(h.service.health()).resolves.toMatchObject({ reachable: false, detail: 'liveness check answered HTTP 503', pending: 0 })
    expect(await h.service.health()).not.toHaveProperty('account')
  })

  it('reports a daemon that does not name its account and a configured account it does not serve', async () => {
    const quiet = await harness({ receive: false }, { before: (daemon) => { daemon.answers.set('listAccounts', [{ error: { code: -32601, message: 'Method not implemented' } }]) } })
    await until(() => quiet.logs.some(log => log.text.startsWith('signal-cli: connected')))
    expect(quiet.logs.map(log => log.text)).toContain(`signal-cli: connected to ${quiet.daemon.baseUrl}; the daemon did not report its account`)
    const many = await harness({ receive: false }, { before: (daemon) => { daemon.answers.set('listAccounts', [{ result: [{ number: '+15550001111' }, { number: '+15550002222' }] }]) } })
    await until(() => many.logs.some(log => log.text.startsWith('signal-cli: connected')))
    expect(many.logs.map(log => log.text)).toContain(`signal-cli: connected to ${many.daemon.baseUrl}; the daemon did not report its account`)
    const one = await harness({ receive: false }, { before: (daemon) => { daemon.answers.set('listAccounts', [{ result: [{ number: 'bogus' }, { number: '+15550001111' }] }]) } })
    await until(() => one.logs.some(log => log.text.startsWith('signal-cli: connected')))
    expect(one.logs.map(log => log.text)).toContain('signal-cli: connected as +*********11')
    const odd = await harness({ receive: false, account: '+15559990099' }, { before: (daemon) => { daemon.answers.set('listAccounts', [{ result: 'unexpected' }]) } })
    await until(() => odd.logs.some(log => log.text.startsWith('signal-cli: connected')))
    expect(odd.logs.map(log => log.text)).toContain('signal-cli: connected as +*********99')
    const wrong = await harness({ receive: false, account: '+15559990099' })
    await until(() => wrong.logs.some(log => log.text.startsWith('signal-cli: connected')))
    expect(wrong.logs.map(log => log.text)).toEqual(expect.arrayContaining([
      'signal-cli: account +*********99 is not registered with the daemon; sends will fail',
      'signal-cli: connected as +*********99',
    ]))
  })

  it('publishes inbound data messages as signal/message after reconnecting the event stream', async () => {
    const h = await harness({}, { before: (daemon) => { daemon.eventStatuses.push(503) } })
    const received: SignalInboundMessage[] = []
    h.ctx.on('signal/message', (message) => { received.push(message) })
    await h.daemon.streamOpen()
    expect(h.logs.map(log => log.text)).toContain('signal-cli: event stream failed (event stream answered HTTP 503); reconnecting in 10 ms')
    h.daemon.push(JSON.stringify({ envelope: { timestamp: 1, typingMessage: { action: 'STARTED', timestamp: 1 } } }))
    h.daemon.push(JSON.stringify({ envelope: { timestamp: 1, sourceNumber: '+15551234567', dataMessage: { timestamp: 2, message: 'hello', groupInfo: { groupId: GROUP_ID, revision: 1 } } } }))
    await until(() => received.length === 1)
    expect(received).toEqual([{ sender: { number: '+15551234567' }, groupId: GROUP_ID, text: 'hello', timestamp: 2, attachments: [] }])
  })

  it('abandons a delivery the daemon refuses permanently', async () => {
    const h = await harness({ receive: false }, { before: (daemon) => { daemon.answers.set('send', [{ error: { code: -1, message: 'Invalid group id' } }]) } })
    await h.service.send({ id: SignalDeliveryId('bad'), target: GROUP, text: 'x' })
    await until(() => h.logs.some(log => log.type === 'error'))
    expect(h.logs).toContainEqual({ type: 'error', text: 'signal-cli: delivery bad abandoned after permanent failure: signal-cli error -1: Invalid group id' })
  })

  it('stops quietly when disposed before the daemon answers', async () => {
    const h = await harness({ receive: false }, { before: (daemon) => { daemon.answers.set('listAccounts', [{ hang: true }]) } })
    await until(() => h.daemon.calls.some(call => call.method === 'listAccounts'))
    await h.ctx.fiber.dispose()
    expect(h.logs.filter(log => log.text.startsWith('signal-cli: connected') || log.type === 'error')).toEqual([])
  })
})

describe('sendParams', () => {
  it('passes a standard base64 group id with "+", "/", and "=" unchanged', () => {
    const id = '1QtO3Hub7LE5w2ErIhBrS+WLYdHawvpk03PJMnYREh8='
    expect(sendParams({ transport: 'signal', kind: 'group', groupId: SignalGroupId(id) }, 'x', undefined, undefined)).toEqual({ groupId: id, message: 'x' })
    const slashed = '+///AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
    expect(sendParams({ transport: 'signal', kind: 'group', groupId: SignalGroupId(slashed) }, 'x', undefined, undefined)).toMatchObject({ groupId: slashed })
  })

  it('addresses a group or a number and adds only present fields', () => {
    expect(sendParams(GROUP, 'plain', undefined, undefined)).toEqual({ groupId: GROUP_ID, message: 'plain' })
    expect(sendParams(PERSON, '**b**', 'data:x', SignalNumber('+15550001234'))).toEqual({
      account: '+15550001234', recipient: ['+15551234567'], message: 'b', textStyle: ['0:1:BOLD'], attachments: ['data:x'],
    })
  })
})
