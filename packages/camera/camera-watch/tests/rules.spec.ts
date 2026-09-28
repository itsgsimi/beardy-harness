import { describe, expect, it } from 'vitest'
import type { CameraVerdict } from '@deepseek-ai/dsh-camera'
import { resolveConfig, WATCH_DEFAULTS } from '../src/config.ts'
import type { Config, ResolvedPolicy } from '../src/config.ts'
import { localDateTime, renderNotice } from '../src/notice.ts'
import { insideWindow, lingeringMs, localMinute, noticeReasons } from '../src/policy.ts'
import type { PolicyEvent } from '../src/policy.ts'
import { classificationPrompt, parseVerdict } from '../src/verdict.ts'
import { NIGHT, NOON } from './support.ts'

const TZ = 'America/Phoenix'

describe('resolveConfig', () => {
  it('applies every package default', () => {
    const resolved = resolveConfig({ timezone: TZ })
    expect(resolved).toEqual({
      timezone: TZ,
      policy: { ding: true, packageDelivered: true, nightPerson: true, nightStartMinute: 21 * 60, nightEndMinute: 6 * 60,
        vehicleDevices: [], lingerMs: 20_000, minConfidence: 0.5 },
      maxOutputTokens: 600, turnTimeoutMs: 120_000, maxConcurrent: 1, maxQueued: 10, retentionMs: 30 * 86_400_000,
      maxHistory: 5_000, sweepIntervalMs: 3_600_000, deliveryAttempts: 3, deliveryRetryMs: 30_000, tool: true, toolMaxEvents: 50,
    })
    expect(WATCH_DEFAULTS.lingerSeconds).toBe(20)
  })

  it('keeps explicit values', () => {
    const config: Config = {
      timezone: 'UTC', modelSelection: { provider: 'mock', model: 'vision', reasoningEffort: 'low' }, deliverChannelId: '123456789012345678',
      workspacePath: '/srv/beardy',
      policy: { ding: false, packageDelivered: false, nightPerson: false, nightStart: '22:15', nightEnd: '05:45', vehicleDevices: ['garage', 'garage'],
        lingerSeconds: 30, minConfidence: 0.7 },
      maxOutputTokens: 100, turnTimeoutMs: 9_000, maxConcurrent: 2, maxQueued: 3, retentionDays: 2, maxHistory: 9,
      sweepIntervalMs: 70_000, deliveryAttempts: 5, deliveryRetryMs: 2_000, tool: false, toolMaxEvents: 7,
    }
    expect(resolveConfig(config)).toEqual({
      timezone: 'UTC', modelSelection: { provider: 'mock', model: 'vision', reasoningEffort: 'low' }, deliverChannelId: '123456789012345678',
      workspacePath: '/srv/beardy',
      policy: { ding: false, packageDelivered: false, nightPerson: false, nightStartMinute: 22 * 60 + 15, nightEndMinute: 5 * 60 + 45,
        vehicleDevices: ['garage'], lingerMs: 30_000, minConfidence: 0.7 },
      maxOutputTokens: 100, turnTimeoutMs: 9_000, maxConcurrent: 2, maxQueued: 3, retentionMs: 2 * 86_400_000, maxHistory: 9,
      sweepIntervalMs: 70_000, deliveryAttempts: 5, deliveryRetryMs: 2_000, tool: false, toolMaxEvents: 7,
    })
  })

  it.each([
    [{ timezone: 'Mars/Olympus' }, /not a known IANA time zone/],
    [{ timezone: TZ, deliverChannelId: 'general' }, /Discord snowflake/],
    [{ timezone: TZ, workspacePath: 'relative/path' }, /must be absolute/],
    [{ timezone: TZ, policy: { nightStart: '9pm' } }, /nightStart must be HH:MM/],
    [{ timezone: TZ, policy: { nightEnd: '24:00' } }, /nightEnd must be HH:MM/],
    [{ timezone: TZ, policy: { nightStart: '06:00', nightEnd: '06:00' } }, /must differ/],
  ] as [Config, RegExp][])('rejects %j', (config, message) => {
    expect(() => resolveConfig(config)).toThrow(message)
  })
})

describe('classificationPrompt', () => {
  it('states the alert, camera, time, and frame offsets and asks for one JSON object', () => {
    expect(classificationPrompt({ kind: 'ding', deviceLabel: 'Front door', localTime: '2026-09-27 12:00:00', offsetsMs: [0, 10_400, 21_000] })).toBe([
      'Classify this doorbell press from the Front door camera at 2026-09-27 12:00:00. The 3 images are frames in capture order, taken 0 s, 10 s, 21 s after the alert.',
      '',
      'Reply with only one JSON object and no other text:',
      '{"labels":[],"counts":{},"activity":"none","confidence":0,"description":"","personFrames":[]}',
      '',
      '- labels: each of "person", "vehicle", "package", "animal" visible in any frame.',
      '- counts: the most of each label visible at once, for example {"person":1}.',
      '- activity: one of "delivering", "lingering", "passing", "ringing", "none".',
      '- confidence: how sure you are, from 0 to 1.',
      '- description: one sentence of at most 25 words about what is happening. Do not guess who anyone is.',
      '- personFrames: zero-based indices of the frames that show a person.',
    ].join('\n'))
    expect(classificationPrompt({ kind: 'motion', deviceLabel: 'Garage', localTime: 't', offsetsMs: [0] }))
      .toContain('Classify this motion alert from the Garage camera at t. The 1 image is a frame in capture order, taken 0 s after the alert.')
  })
})

describe('parseVerdict', () => {
  it('reads a complete verdict', () => {
    expect(parseVerdict('{"labels":["person","package"],"counts":{"person":1,"package":1},"activity":"delivering","confidence":0.82,'
      + '"description":"A courier sets a box by the door.","personFrames":[0,1]}', 3)).toEqual({
      status: 'parsed',
      verdict: { labels: ['person', 'package'], counts: { person: 1, package: 1 }, activity: 'delivering', confidence: 0.82,
        description: 'A courier sets a box by the door.', personFrames: [0, 1] },
    })
  })

  it('finds the object inside fences and prose, skipping braces in strings and invalid candidates', () => {
    const text = 'Sure! {not json} Here it is:\n```json\n{"labels":["People","cars","boxes","Dogs"],"counts":{"people":2,"car":1,"truck":2},'
      + '"activity":"Passing","confidence":"85%","description":"Two people {walk} past\\n a \\"car\\".","personFrames":[2,0,0]}\n```'
    expect(parseVerdict(text, 3)).toEqual({
      status: 'parsed',
      verdict: { labels: ['person', 'vehicle', 'package', 'animal'], counts: { person: 2, vehicle: 2 }, activity: 'passing', confidence: 0.85,
        description: 'Two people {walk} past a "car".', personFrames: [0, 2] },
    })
  })

  it('keeps what it can from a partial answer', () => {
    expect(parseVerdict('{"labels":["person","ghost",3],"counts":{"person":-1,"alien":1,"package":0,"animal":150},"activity":"dancing",'
      + '"confidence":250,"personFrames":[1,7,"x"]}', 2)).toEqual({
      status: 'partial',
      verdict: { labels: ['person', 'animal'], counts: { package: 0, animal: 99 }, activity: 'unknown', confidence: 0,
        description: 'Visible: person, animal.', personFrames: [1] },
    })
    expect(parseVerdict('{"labels":"person","counts":[],"confidence":"high","description":"   "}', 1)).toEqual({
      status: 'partial',
      verdict: { labels: [], counts: {}, activity: 'unknown', confidence: 0, description: 'Nothing identified.', personFrames: [] },
    })
    expect(parseVerdict('{"labels":[],"counts":{},"activity":"none","confidence":"","description":"x","personFrames":[]}', 1).verdict?.confidence).toBe(0)
    expect(parseVerdict('{"labels":[],"counts":{},"activity":"none","confidence":0.5,"description":"x","personFrames":{}}', 1).status).toBe('partial')
    expect(parseVerdict('{"labels":[],"counts":null,"activity":"none","confidence":0.5,"description":"x","personFrames":[]}', 1).status).toBe('partial')
    expect(parseVerdict('{"labels":[],"counts":{},"activity":"unknown","confidence":1,"description":"x","personFrames":[]}', 1).status).toBe('partial')
    expect(parseVerdict('{"labels":[],"counts":{},"activity":7,"confidence":1,"description":"x","personFrames":[]}', 1).verdict?.activity).toBe('unknown')
  })

  it('reports malformed output as unparsed with a bounded one-line account', () => {
    expect(parseVerdict('I see a person\nat the door.', 3)).toEqual({ status: 'unparsed', text: 'I see a person at the door.' })
    expect(parseVerdict('[1, 2] {"unterminated": ', 3)).toEqual({ status: 'unparsed', text: '[1, 2] {"unterminated":' })
    expect(parseVerdict('["an array"]', 1).status).toBe('unparsed')
    const long = parseVerdict(`{"labels":[],"counts":{},"activity":"none","confidence":1,"personFrames":[],"description":"${'a'.repeat(300)}"}`, 1)
    expect(long.verdict?.description).toHaveLength(200)
    expect(parseVerdict('x'.repeat(500), 1).text).toHaveLength(200)
  })
})

const policy: ResolvedPolicy = {
  ding: true, packageDelivered: true, nightPerson: true, nightStartMinute: 21 * 60, nightEndMinute: 6 * 60,
  vehicleDevices: ['garage'], lingerMs: 20_000, minConfidence: 0.5,
}

function verdict(fields: Partial<CameraVerdict>): CameraVerdict {
  return { labels: [], counts: {}, activity: 'none', confidence: 0.9, description: 'x', personFrames: [], ...fields }
}

function event(fields: Partial<PolicyEvent> = {}): PolicyEvent {
  return { kind: 'motion', deviceId: 'front-door', occurredAt: NOON, offsetsMs: [0, 10_000, 21_000], ...fields }
}

describe('noticeReasons', () => {
  it('notifies every doorbell press, with or without a verdict', () => {
    expect(noticeReasons(event({ kind: 'ding' }), undefined, 'failed', policy, TZ)).toEqual(['ding'])
    expect(noticeReasons(event({ kind: 'ding' }), verdict({}), 'parsed', policy, TZ)).toEqual(['ding'])
    expect(noticeReasons(event({ kind: 'ding' }), undefined, 'skipped', { ...policy, ding: false }, TZ)).toEqual([])
  })

  it('notifies a delivered package, not a package that is only visible', () => {
    expect(noticeReasons(event(), verdict({ labels: ['person', 'package'], activity: 'delivering', personFrames: [0] }), 'parsed', policy, TZ)).toEqual(['package'])
    expect(noticeReasons(event(), verdict({ labels: ['package'], activity: 'none' }), 'parsed', policy, TZ)).toEqual([])
    expect(noticeReasons(event(), verdict({ labels: ['package'], activity: 'delivering' }), 'parsed', { ...policy, packageDelivered: false }, TZ)).toEqual([])
  })

  it('notifies a person inside the night window across midnight', () => {
    const night = verdict({ labels: ['person'], personFrames: [0] })
    expect(noticeReasons(event({ occurredAt: NIGHT }), night, 'parsed', policy, TZ)).toEqual(['night-person'])
    expect(noticeReasons(event({ occurredAt: Date.UTC(2026, 8, 28, 12, 59) }), night, 'parsed', policy, TZ)).toEqual(['night-person'])
    expect(noticeReasons(event({ occurredAt: Date.UTC(2026, 8, 28, 13, 0) }), night, 'parsed', policy, TZ)).toEqual([])
    expect(noticeReasons(event(), night, 'parsed', policy, TZ)).toEqual([])
    expect(noticeReasons(event({ occurredAt: NIGHT }), verdict({ labels: ['animal'] }), 'parsed', policy, TZ)).toEqual([])
    expect(noticeReasons(event({ occurredAt: NIGHT }), night, 'parsed', { ...policy, nightPerson: false }, TZ)).toEqual([])
  })

  it('notifies a vehicle only on configured devices', () => {
    const car = verdict({ labels: ['vehicle'], counts: { vehicle: 1 } })
    expect(noticeReasons(event({ deviceId: 'garage' }), car, 'parsed', policy, TZ)).toEqual(['vehicle'])
    expect(noticeReasons(event(), car, 'parsed', policy, TZ)).toEqual([])
    expect(noticeReasons(event({ deviceId: 'garage' }), verdict({ labels: ['person'] }), 'parsed', policy, TZ)).toEqual([])
  })

  it('notifies lingering from person frames spanning the threshold, not from the model activity', () => {
    const person = { labels: ['person'] as const }
    expect(noticeReasons(event(), verdict({ ...person, personFrames: [0, 2] }), 'parsed', policy, TZ)).toEqual(['lingering'])
    expect(noticeReasons(event(), verdict({ ...person, personFrames: [0, 1], activity: 'lingering' }), 'parsed', policy, TZ)).toEqual([])
    expect(noticeReasons(event(), verdict({ ...person, personFrames: [2] }), 'parsed', policy, TZ)).toEqual([])
    expect(lingeringMs(event({ offsetsMs: [0, 5_000, 30_000] }), verdict({ personFrames: [0, 1, 2] }))).toBe(30_000)
  })

  it('stays quiet below the confidence floor or without a usable verdict', () => {
    const box = verdict({ labels: ['package'], activity: 'delivering', confidence: 0.4 })
    expect(noticeReasons(event(), box, 'parsed', policy, TZ)).toEqual([])
    expect(noticeReasons(event(), { ...box, confidence: 0.6 }, 'partial', policy, TZ)).toEqual(['package'])
    expect(noticeReasons(event(), undefined, 'unparsed', policy, TZ)).toEqual([])
    expect(noticeReasons(event(), { ...box, confidence: 0.9 }, 'failed', policy, TZ)).toEqual([])
    expect(noticeReasons(event(), verdict({ labels: ['person'], activity: 'passing' }), 'parsed', policy, TZ)).toEqual([])
  })

  it('reads local minutes and windows in both directions', () => {
    expect(localMinute(NOON, TZ)).toBe(12 * 60)
    expect(localMinute(NIGHT, TZ)).toBe(23 * 60 + 30)
    expect(insideWindow(600, 540, 1_020)).toBe(true)
    expect(insideWindow(1_020, 540, 1_020)).toBe(false)
    expect(insideWindow(539, 540, 1_020)).toBe(false)
    expect(insideWindow(0, 1_260, 360)).toBe(true)
  })
})

describe('renderNotice', () => {
  const base = { deviceLabel: 'Front door', occurredAt: NIGHT, timezone: TZ, lingerSeconds: 0 }

  it('states device, time, reasons, description, counts, and confidence', () => {
    expect(renderNotice({ ...base, reasons: ['ding', 'package', 'night-person', 'vehicle', 'lingering'], status: 'parsed', lingerSeconds: 21,
      verdict: verdict({ description: 'A courier with a box.', counts: { person: 1, package: 1, animal: 0 }, confidence: 0.834 }) })).toBe([
      '**Front door** · 23:30: Doorbell rang; Package delivered; Person at night; Vehicle seen; Someone lingering (21 s)',
      'A courier with a box.',
      'Seen: person 1, package 1 · confidence 83%',
    ].join('\n'))
    expect(renderNotice({ ...base, reasons: ['ding'], status: 'partial', verdict: verdict({ description: 'Nothing identified.', confidence: 0 }) }))
      .toContain('Nothing counted · confidence 0%')
  })

  it('explains a missing description', () => {
    expect(renderNotice({ ...base, reasons: ['ding'], status: 'unparsed', text: 'I think someone is there.' }).split('\n')[1]).toBe('I think someone is there.')
    expect(renderNotice({ ...base, reasons: ['ding'], status: 'unparsed' }).split('\n')).toHaveLength(1)
    expect(renderNotice({ ...base, reasons: ['ding'], status: 'skipped', failure: 'NO_FRAMES', captureFailure: 'snapshot-unavailable' }).split('\n').slice(1))
      .toEqual(['No picture could be captured.', 'Fewer pictures than planned (snapshot-unavailable).'])
    expect(renderNotice({ ...base, reasons: ['ding'], status: 'skipped', failure: 'QUEUE_FULL' })).toContain('Not checked: earlier events were still being checked.')
    expect(renderNotice({ ...base, reasons: ['ding'], status: 'failed', failure: 'TIMEOUT' })).toContain('The vision check did not answer (TIMEOUT).')
    expect(renderNotice({ ...base, reasons: ['ding'], status: 'failed' })).toContain('(unknown)')
  })

  it('formats local date and time', () => {
    expect(localDateTime(NIGHT, TZ)).toBe('2026-09-27 23:30:00')
    expect(localDateTime(NIGHT, 'UTC')).toBe('2026-09-28 06:30:00')
  })
})
