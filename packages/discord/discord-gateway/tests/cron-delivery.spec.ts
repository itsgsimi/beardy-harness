import { describe, expect, it, vi } from 'vitest'
import { attachCronDelivery } from '../src/conversation.ts'
import { CHANNEL, harness } from './support.ts'

const settle = (ms = 5): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('attachCronDelivery', () => {
  it('posts the finished run text to its delivery channel', async () => {
    const h = harness()
    attachCronDelivery(h.ctx, h.router)
    h.emitEvent('cron/run-finished', {
      jobName: 'brief', sessionId: 's-1', firedAt: 1, outcome: 'answered', text: 'Brief ready.',
      deliverChannelId: CHANNEL, reportOutcome: true,
    })
    await settle()
    expect(h.posted).toEqual([{ content: 'Brief ready.', channelId: CHANNEL, token: 'tok' }])
  })

  it('posts an outcome line when the run has no text', async () => {
    const h = harness()
    attachCronDelivery(h.ctx, h.router)
    h.emitEvent('cron/run-finished', {
      jobName: 'brief', sessionId: '', firedAt: 1, outcome: 'failed', text: '',
      deliverChannelId: CHANNEL, reportOutcome: true,
    })
    await settle()
    expect(h.posted[0]?.content).toBe('The scheduled run "brief" failed (FAILED). Session: unavailable. Next fire: none.')
  })

  it('posts a skipped-fire notice through the cron outcome listener', async () => {
    const h = harness()
    attachCronDelivery(h.ctx, h.router)
    h.emitEvent('cron/run-finished', {
      jobName: 'morning-brief', sessionId: 'cron-skipped-1', firedAt: 2, outcome: 'skipped', text: '',
      failure: { code: 'PREVIOUS_RUN_IN_PROGRESS', message: 'The previous run was still in progress.' },
      deliverChannelId: CHANNEL, reportOutcome: true, nextFireAt: '2026-09-28T14:00:00.000Z',
    })
    await settle()
    expect(h.posted[0]?.content).toBe('The scheduled run "morning-brief" was skipped because its previous run was still in progress. Next fire: 2026-09-28T14:00:00.000Z.')
  })

  it('posts one enriched failed-run notice even when the delivery handoff repeats', async () => {
    const h = harness()
    attachCronDelivery(h.ctx, h.router)
    const run = { jobName: 'morning-brief', sessionId: 'cron-s1', firedAt: 1,
      outcome: 'failed', text: 'partial', failure: { code: 'TRANSPORT', message: 'private' },
      nextFireAt: '2026-09-28T07:00:00.000Z', deliverChannelId: CHANNEL, reportOutcome: true }
    h.emitEvent('cron/run-finished', run)
    await settle()
    expect(h.posted.map(post => post.content)).toEqual([
      'The scheduled run "morning-brief" failed (TRANSPORT). Session: cron-s1. Next fire: 2026-09-28T07:00:00.000Z.',
    ])
  })

  it('ignores runs without a delivery channel and runs with nothing to say', async () => {
    const h = harness()
    attachCronDelivery(h.ctx, h.router)
    h.emitEvent('cron/run-finished', {
      jobName: 'brief', sessionId: 's-1', firedAt: 1, outcome: 'answered', text: 'x', reportOutcome: true,
    })
    h.emitEvent('cron/run-finished', {
      jobName: 'brief', sessionId: 's-2', firedAt: 2, outcome: 'timed-out', text: '',
      deliverChannelId: CHANNEL, reportOutcome: false,
    })
    await settle()
    expect(h.posted).toEqual([])
  })

  it('reports a failed delivery as a warning instead of throwing', async () => {
    const h = harness({ failPost: true })
    attachCronDelivery(h.ctx, h.router)
    h.emitEvent('cron/run-finished', {
      jobName: 'brief', sessionId: 's-1', firedAt: 1, outcome: 'answered', text: 'Brief ready.',
      deliverChannelId: CHANNEL, reportOutcome: true,
    })
    await settle()
    expect(h.warnings.some(line => line.includes(`reply to channel ${CHANNEL} failed`))).toBe(true)
  })

  it('claims Discord and discord-prefixed targets and leaves Signal and unparseable targets to other owners', async () => {
    let handler: ((payload: Record<string, unknown>) => Promise<true | undefined>) | undefined
    const deliver = vi.fn(async () => {})
    attachCronDelivery({ on: (_event: string, listener: typeof handler) => { handler = listener } } as never, { deliver } as never)
    const run = { jobName: 'brief', sessionId: 's-1', firedAt: 1, outcome: 'answered', text: 'Brief ready.', reportOutcome: true }
    expect(await handler?.({ ...run, deliverChannelId: `discord:${CHANNEL}` })).toBe(true)
    expect(deliver).toHaveBeenCalledWith(CHANNEL, 'Brief ready.', 'cron:s-1:1')
    for (const target of ['signal:number:+15551234567', `signal:group:${Buffer.alloc(32, 1).toString('base64')}`, 'chan-9']) {
      expect(await handler?.({ ...run, deliverChannelId: target })).toBeUndefined()
    }
    expect(await handler?.(run)).toBeUndefined()
    expect(deliver).toHaveBeenCalledTimes(1)
  })
})
