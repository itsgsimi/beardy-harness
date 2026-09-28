import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SignalService, { SignalDeliveryId, SignalGroupId, SignalNumber, SignalServiceId } from '../src/index.ts'
import type { SignalDeliveryResult, SignalHealth, SignalInboundMessage, SignalSendRequest } from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

const GROUP = Buffer.alloc(32, 4).toString('base64')

class FixtureSignal extends SignalService {
  readonly sent: SignalSendRequest[] = []
  async send(request: SignalSendRequest): Promise<SignalDeliveryResult> {
    this.sent.push(request)
    return { id: request.id ?? SignalDeliveryId('fresh'), state: 'queued' }
  }
  async health(): Promise<SignalHealth> { return { reachable: true, checkedAt: 1, pending: 0 } }
  async receive(message: SignalInboundMessage): Promise<void> { await this.publishMessage(message) }
}

function message(): SignalInboundMessage {
  return { sender: { number: SignalNumber('+15551234567') }, groupId: SignalGroupId(GROUP), text: 'hi', timestamp: 42, attachments: [] }
}

async function mount(): Promise<{ ctx: Context; signal: FixtureSignal }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(FixtureSignal)
  return { ctx, signal: ctx.signal as FixtureSignal }
}

describe('Signal identities', () => {
  it('validates group ids, numbers, service ids, and delivery ids', () => {
    expect(SignalGroupId(GROUP)).toBe(GROUP)
    expect(() => SignalGroupId('abc')).toThrow(/standard base64 of 32 bytes/)
    expect(SignalNumber('+15551234567')).toBe('+15551234567')
    expect(() => SignalNumber('5551234567')).toThrow(/E\.164/)
    expect(SignalServiceId('A1B2C3D4-0000-4000-8000-00000000000F')).toBe('a1b2c3d4-0000-4000-8000-00000000000f')
    expect(() => SignalServiceId('nope')).toThrow(/UUID/)
    expect(SignalDeliveryId('camera:ring-1-2:ding')).toBe('camera:ring-1-2:ding')
    for (const bad of ['', 'has space', 'x'.repeat(201), 'tab\there']) expect(() => SignalDeliveryId(bad)).toThrow(/delivery id/)
  })
})

describe('SignalService', () => {
  it('refuses construction of the abstract definition', () => {
    const ctx = new Context()
    contexts.push(ctx)
    expect(() => { Reflect.construct(SignalService, [ctx]) }).toThrow(/load a Signal provider/)
  })

  it('registers as ctx.signal and delivers inbound messages to every listener', async () => {
    const { ctx, signal } = await mount()
    const seen: string[] = []
    ctx.on('signal/message', (received) => { seen.push(`a:${received.text}`) })
    ctx.on('signal/message', async (received) => { seen.push(`b:${String(received.timestamp)}`) })
    await signal.receive(message())
    expect(seen).toEqual(['a:hi', 'b:42'])
    await expect(ctx.signal.send({ target: { transport: 'signal', kind: 'group', groupId: SignalGroupId(GROUP) }, text: 'x' }))
      .resolves.toEqual({ id: 'fresh', state: 'queued' })
    await expect(ctx.signal.health()).resolves.toMatchObject({ reachable: true })
  })

  it('contains listener failures and still reaches the other listeners', async () => {
    const { ctx, signal } = await mount()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const seen: number[] = []
    ctx.on('signal/message', () => { throw new Error('first broke') })
    ctx.on('signal/message', async () => { throw 'second broke' })
    ctx.on('signal/message', (received) => { seen.push(received.timestamp) })
    await expect(signal.receive(message())).resolves.toBeUndefined()
    expect(seen).toEqual([42])
    expect(warn.mock.calls.map(call => String(call[0]))).toEqual([
      'signal: a signal/message listener failed for message 42: first broke',
      'signal: a signal/message listener failed for message 42: second broke',
    ])
  })
})
