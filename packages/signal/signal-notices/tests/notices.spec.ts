import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import SignalService, { SignalDeliveryId } from '@deepseek-ai/dsh-signal'
import type { SignalDeliveryResult, SignalHealth, SignalSendRequest } from '@deepseek-ai/dsh-signal'
import * as notices from '../src/index.ts'

const GROUP_ID = Buffer.alloc(32, 3).toString('base64')
const GROUP = `signal:group:${GROUP_ID}`
const contexts: Context[] = []

afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

class FixtureSignal extends SignalService {
  readonly sent: SignalSendRequest[] = []
  async send(request: SignalSendRequest): Promise<SignalDeliveryResult> {
    this.sent.push(request)
    return { id: request.id ?? SignalDeliveryId('fresh'), state: 'queued' }
  }
  async health(): Promise<SignalHealth> { return { reachable: true, checkedAt: 0, pending: 0 } }
}

async function mount(): Promise<{ ctx: Context; signal: FixtureSignal }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(FixtureSignal)
  await ctx.plugin(notices)
  return { ctx, signal: ctx.signal as FixtureSignal }
}

const IMAGE = { attachmentId: AttachmentId('sha256:frame'), mediaType: 'image/jpeg' as const, bytes: 3, width: 2, height: 2 }

describe('signal-notices', () => {
  it('claims camera notices and health transitions with Signal targets', async () => {
    const { ctx, signal } = await mount()
    await expect(ctx.serial('camera/notice', { id: 'camera:ring-1', channelId: GROUP, text: '**Front door**: Doorbell rang', image: IMAGE })).resolves.toBe(true)
    await expect(ctx.serial('health/transition', { id: 'health:t1', channelId: 'signal:number:+15551234567', text: 'Probe main: down.' })).resolves.toBe(true)
    expect(signal.sent).toEqual([
      { id: 'camera:ring-1', target: { transport: 'signal', kind: 'group', groupId: GROUP_ID }, text: '**Front door**: Doorbell rang', image: IMAGE },
      { id: 'health:t1', target: { transport: 'signal', kind: 'number', number: '+15551234567' }, text: 'Probe main: down.' },
    ])
  })

  it('leaves Discord and unparseable targets to their owners', async () => {
    const { ctx, signal } = await mount()
    await expect(ctx.serial('camera/notice', { id: 'c', channelId: '123456789012345678', text: 'x' })).resolves.toBeUndefined()
    await expect(ctx.serial('health/transition', { id: 'h', channelId: 'discord:123456789012345678', text: 'x' })).resolves.toBeUndefined()
    await expect(ctx.serial('cron/run-finished', { jobName: 'j', sessionId: 's', firedAt: 1, outcome: 'answered', text: 'x',
      deliverChannelId: 'general', reportOutcome: true })).resolves.toBeUndefined()
    await expect(ctx.serial('cron/run-finished', { jobName: 'j', sessionId: 's', firedAt: 1, outcome: 'answered', text: 'x', reportOutcome: true }))
      .resolves.toBeUndefined()
    expect(signal.sent).toEqual([])
  })

  it('delivers cron text and outcome lines and accepts a run with nothing to say', async () => {
    const { ctx, signal } = await mount()
    const run = { jobName: 'brief', sessionId: 's-1', firedAt: 7, deliverChannelId: GROUP, reportOutcome: true } as const
    await expect(ctx.serial('cron/run-finished', { ...run, outcome: 'answered', text: 'Brief ready.' })).resolves.toBe(true)
    await expect(ctx.serial('cron/run-finished', { ...run, sessionId: 's-2', outcome: 'failed', text: '' })).resolves.toBe(true)
    await expect(ctx.serial('cron/run-finished', { ...run, sessionId: 's-3', outcome: 'skipped', text: '', reportOutcome: false })).resolves.toBe(true)
    expect(signal.sent.map(request => [request.id, request.text])).toEqual([
      ['cron:s-1:7', 'Brief ready.'],
      ['cron:s-2:7', 'The scheduled run "brief" failed (FAILED). Session: s-2. Next fire: none.'],
    ])
  })
})
