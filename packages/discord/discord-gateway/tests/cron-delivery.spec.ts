import { describe, expect, it } from 'vitest'
import { attachCronDelivery, cronDeliveryContent } from '../src/conversation.ts'
import { CHANNEL, harness } from './support.ts'

const settle = (ms = 5): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('cron delivery content', () => {
  const runs: [string, Parameters<typeof cronDeliveryContent>[0], string | undefined][] = [
    ['answered with text', { outcome: 'answered', text: 'Brief ready.', reportOutcome: true }, 'Brief ready.'],
    ['no text, report wanted', { outcome: 'no-text-answer', text: '', reportOutcome: true }, 'The scheduled run finished without a text answer.'],
    ['timed out, report wanted', { outcome: 'timed-out', text: '', reportOutcome: true }, 'The scheduled run timed out.'],
    ['interrupted, report wanted', { outcome: 'interrupted', text: '', reportOutcome: true }, 'The scheduled run was interrupted.'],
    ['failed, report wanted', { outcome: 'failed', text: '', reportOutcome: true }, 'The scheduled run failed (FAILED). Session: unavailable. Next fire: none.'],
    ['failed after text, code only', { outcome: 'failed', text: 'partial', failure: { code: 'SERVER', message: 'private detail' }, reportOutcome: true }, 'The scheduled run failed (SERVER). Session: unavailable. Next fire: none.'],
    ['failed with unsafe code', { outcome: 'failed', text: '', failure: { code: 'secret: abc', message: 'private detail' }, reportOutcome: true }, 'The scheduled run failed (FAILED). Session: unavailable. Next fire: none.'],
    ['failed after text, report declined', { outcome: 'failed', text: 'partial', failure: { code: 'SERVER', message: 'private detail' }, reportOutcome: false }, undefined],
    ['no text, report declined', { outcome: 'timed-out', text: '', reportOutcome: false }, undefined],
  ]
  it.each(runs)('maps %s to the delivery text', (_name, run, expected) => {
    expect(cronDeliveryContent(run)).toBe(expected)
  })
})

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
})
