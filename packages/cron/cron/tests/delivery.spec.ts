import { describe, expect, it } from 'vitest'
import { assertCronDeliveryTarget, cronDeliveryContent } from '../src/delivery.ts'

describe('cron delivery content', () => {
  const runs: [string, Parameters<typeof cronDeliveryContent>[0], string | undefined][] = [
    ['answered with text', { outcome: 'answered', text: 'Brief ready.', reportOutcome: true }, 'Brief ready.'],
    ['no text, report wanted', { outcome: 'no-text-answer', text: '', reportOutcome: true }, 'The scheduled run finished without a text answer.'],
    ['timed out, report wanted', { outcome: 'timed-out', text: '', reportOutcome: true }, 'The scheduled run timed out.'],
    ['interrupted, report wanted', { outcome: 'interrupted', text: '', reportOutcome: true }, 'The scheduled run was interrupted.'],
    ['skipped, report wanted', { outcome: 'skipped', text: '', reportOutcome: true }, 'The scheduled run was skipped because its previous run was still in progress. Next fire: none.'],
    ['skipped, previous delivery pending', { outcome: 'skipped', text: '', failure: { code: 'PREVIOUS_OUTCOME_PENDING', message: 'pending' }, reportOutcome: true }, 'The scheduled run was skipped because its previous outcome is awaiting delivery. Next fire: none.'],
    ['skipped, report declined', { outcome: 'skipped', text: '', reportOutcome: false }, undefined],
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

describe('assertCronDeliveryTarget', () => {
  it('accepts every delivery target form and names the field otherwise', () => {
    for (const target of ['123456789012345678', 'discord:123456789012345678', 'signal:number:+15551234567']) {
      expect(() => { assertCronDeliveryTarget(target, 'deliver_channel') }).not.toThrow()
    }
    expect(() => { assertCronDeliveryTarget('chan-9', 'deliver_channel') }).toThrow(/^deliver_channel must be a Discord channel id/)
  })
})
