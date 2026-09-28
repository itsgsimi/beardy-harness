import { describe, expect, it } from 'vitest'
import type { CameraVerdict } from '@deepseek-ai/dsh-camera'
import { Config as ConfigSchema, resolveConfig, WATCH_DEFAULTS } from '../src/config.ts'
import type { Config, ResolvedPolicy } from '../src/config.ts'
import { frameAttachment, historyRecord, partitionHistory } from '../src/history.ts'
import type { HistoryFrame, HistoryRecord } from '../src/history.ts'
import { localDateTime, renderDingNotice, renderNotice } from '../src/notice.ts'
import { insideWindow, lingeringMs, localMinute, noticeReasons } from '../src/policy.ts'
import type { PolicyEvent } from '../src/policy.ts'
import { CLASSIFICATION_SYSTEM_PROMPT, classificationPrompt, parseVerdict } from '../src/verdict.ts'
import { NIGHT, NOON } from './support.ts'

const TZ = 'America/Phoenix'

describe('resolveConfig', () => {
  it('applies every package default', () => {
    const resolved = resolveConfig({ timezone: TZ })
    expect(resolved).toEqual({
      timezone: TZ,
      policy: { ding: true, packageDelivered: true, nightPerson: true, nightStartMinute: 21 * 60, nightEndMinute: 6 * 60,
        personDevices: [], vehicleDevices: [], vehicleActivities: ['arriving', 'leaving'], lingerMs: 20_000, minConfidence: 0.5 },
      immediateDingNotice: true, maxOutputTokens: 600, turnTimeoutMs: 120_000, maxConcurrent: 1, maxQueued: 10,
      retentionMs: 30 * 86_400_000,
      maxHistory: 5_000, sweepIntervalMs: 3_600_000, deliveryAttempts: 3, deliveryRetryMs: 30_000,
      failureNoticeThreshold: 3, failureNoticeIntervalMs: 21_600_000, tool: true, toolMaxEvents: 50,
    })
    expect(WATCH_DEFAULTS.lingerSeconds).toBe(20)
  })

  it('keeps explicit values', () => {
    const config: Config = {
      timezone: 'UTC', modelSelection: { provider: 'mock', model: 'vision', reasoningEffort: 'low' }, deliverChannelId: '123456789012345678',
      workspacePath: '/srv/beardy',
      policy: { ding: false, packageDelivered: false, nightPerson: false, nightStart: '22:15', nightEnd: '05:45', personDevices: ['front-door', 'front-door'], vehicleDevices: ['garage', 'garage'],
        vehicleActivities: ['passing', 'parked', 'passing'], lingerSeconds: 30, minConfidence: 0.7 },
      immediateDingNotice: false, maxOutputTokens: 100, turnTimeoutMs: 9_000, maxConcurrent: 2, maxQueued: 3,
      retentionDays: 2, maxHistory: 9,
      sweepIntervalMs: 70_000, deliveryAttempts: 5, deliveryRetryMs: 2_000, failureNoticeThreshold: 1, failureNoticeIntervalMs: 60_000,
      tool: false, toolMaxEvents: 7,
    }
    expect(resolveConfig(config)).toEqual({
      timezone: 'UTC', modelSelection: { provider: 'mock', model: 'vision', reasoningEffort: 'low' }, deliverChannelId: '123456789012345678',
      workspacePath: '/srv/beardy',
      policy: { ding: false, packageDelivered: false, nightPerson: false, nightStartMinute: 22 * 60 + 15, nightEndMinute: 5 * 60 + 45,
        personDevices: ['front-door'], vehicleDevices: ['garage'], vehicleActivities: ['passing', 'parked'], lingerMs: 30_000, minConfidence: 0.7 },
      immediateDingNotice: false, maxOutputTokens: 100, turnTimeoutMs: 9_000, maxConcurrent: 2, maxQueued: 3,
      retentionMs: 2 * 86_400_000, maxHistory: 9,
      sweepIntervalMs: 70_000, deliveryAttempts: 5, deliveryRetryMs: 2_000, failureNoticeThreshold: 1, failureNoticeIntervalMs: 60_000,
      tool: false, toolMaxEvents: 7,
    })
  })

  it.each([
    [{ timezone: 'Mars/Olympus' }, /not a known IANA time zone/],
    [{ timezone: TZ, deliverChannelId: 'general' }, /camera-watch: deliverChannelId must be a Discord channel id .*signal:group:/],
    [{ timezone: TZ, workspacePath: 'relative/path' }, /must be absolute/],
    [{ timezone: TZ, policy: { nightStart: '9pm' } }, /nightStart must be HH:MM/],
    [{ timezone: TZ, policy: { nightEnd: '24:00' } }, /nightEnd must be HH:MM/],
    [{ timezone: TZ, policy: { nightStart: '06:00', nightEnd: '06:00' } }, /must differ/],
    [{ timezone: TZ, policy: { vehicleActivities: [] } }, /vehicleActivities must list at least one/],
  ] as [Config, RegExp][])('rejects %j', (config, message) => {
    expect(() => resolveConfig(config)).toThrow(message)
  })

  it('accepts Signal and prefixed Discord delivery targets', () => {
    const group = `signal:group:${Buffer.alloc(32, 3).toString('base64')}`
    for (const target of [group, 'signal:number:+15551234567', 'discord:123456789012345678']) {
      expect(resolveConfig({ timezone: TZ, deliverChannelId: target }).deliverChannelId).toBe(target)
    }
  })

  it('bounds the retention sweep interval between one minute and one day', () => {
    expect(ConfigSchema({ timezone: TZ, sweepIntervalMs: 86_400_000 }).sweepIntervalMs).toBe(86_400_000)
    expect(() => ConfigSchema({ timezone: TZ, sweepIntervalMs: 86_400_001 })).toThrow()
    expect(() => ConfigSchema({ timezone: TZ, sweepIntervalMs: 59_999 })).toThrow()
  })

  it('bounds the failure notice threshold and interval', () => {
    const defaults = ConfigSchema({ timezone: TZ })
    expect([defaults.failureNoticeThreshold, defaults.failureNoticeIntervalMs]).toEqual([3, 21_600_000])
    expect(ConfigSchema({ timezone: TZ, failureNoticeThreshold: 100, failureNoticeIntervalMs: 604_800_000 }))
      .toMatchObject({ failureNoticeThreshold: 100, failureNoticeIntervalMs: 604_800_000 })
    for (const failureNoticeThreshold of [0, 101, 1.5]) expect(() => ConfigSchema({ timezone: TZ, failureNoticeThreshold })).toThrow()
    for (const failureNoticeIntervalMs of [59_999, 604_800_001, 60_000.5]) {
      expect(() => ConfigSchema({ timezone: TZ, failureNoticeIntervalMs })).toThrow()
    }
  })

  it('accepts only vehicle activities that describe a vehicle', () => {
    expect(ConfigSchema({ timezone: TZ }).policy?.vehicleActivities).toEqual(['arriving', 'leaving'])
    expect(() => ConfigSchema({ timezone: TZ, policy: { vehicleActivities: ['none'] } } as never)).toThrow()
  })
})

describe('historyRecord', () => {
  it('reads a verdict stored before vehicle activity existed as unknown and keeps later fields', () => {
    const stored = {
      eventId: 'old', deviceId: 'garage', kind: 'motion', occurredAt: NOON, frames: [], status: 'parsed', reasons: [], delivery: 'none',
      verdict: { labels: ['vehicle'], counts: { vehicle: 3 }, activity: 'none', confidence: 0.9, description: 'Three parked cars.', personFrames: [] },
    }
    expect(historyRecord.parse(stored).verdict?.vehicleActivity).toBe('unknown')
    expect(historyRecord.parse({ ...stored, captureFailure: 'snapshot-stale', earlyDelivery: 'delivered' }))
      .toMatchObject({ captureFailure: 'snapshot-stale', earlyDelivery: 'delivered' })
  })

  it('reads records from before the person reason and records that carry it', () => {
    const stored = {
      eventId: 'old', deviceId: 'front-door', kind: 'motion', occurredAt: NIGHT, frames: [], status: 'parsed', delivery: 'delivered',
      reasons: ['night-person', 'lingering'],
    }
    expect(historyRecord.parse(stored).reasons).toEqual(['night-person', 'lingering'])
    expect(historyRecord.parse({ ...stored, reasons: ['night-person', 'person'] }).reasons).toEqual(['night-person', 'person'])
    expect(historyRecord.safeParse({ ...stored, reasons: ['stranger'] }).success).toBe(false)
  })
})

describe('partitionHistory', () => {
  const record = (eventId: string, occurredAt: number): [string, HistoryRecord] => [eventId, {
    eventId, deviceId: 'front-door', kind: 'motion', occurredAt, frames: [], status: 'skipped', reasons: [], delivery: 'none',
  }]

  it('keeps records at most the retention age old among the newest, and expires the rest oldest last', () => {
    const { expired, kept } = partitionHistory([
      record('edge', NOON - 1_000), record('past', NOON - 1_001), record('new', NOON), record('older', NOON - 5_000),
    ], NOON, 1_000, 5)
    expect(kept.map(entry => entry.eventId)).toEqual(['new', 'edge'])
    expect(expired.map(([key]) => key)).toEqual(['past', 'older'])
    const counted = partitionHistory([record('a', NOON - 2), record('b', NOON - 1), record('c', NOON)], NOON, 1_000, 2)
    expect([counted.kept.map(entry => entry.eventId), counted.expired.map(([key]) => key)]).toEqual([['c', 'b'], ['a']])
  })
})

describe('frameAttachment', () => {
  it('rebuilds the stored image reference with only the fields it was saved with', () => {
    const frame: HistoryFrame = {
      attachmentId: `sha256:${'ab'.repeat(32)}`, mediaType: 'image/jpeg', bytes: 10, width: 16, height: 12, offsetMs: 0, source: 'snapshot',
    }
    expect(frameAttachment(frame)).toEqual({ attachmentId: frame.attachmentId, mediaType: 'image/jpeg', bytes: 10, width: 16, height: 12 })
    expect(frameAttachment({ ...frame, name: 'front-door-1.jpg', originalDimensions: { width: 32, height: 24 }, source: 'stream' })).toEqual({
      attachmentId: frame.attachmentId, mediaType: 'image/jpeg', bytes: 10, width: 16, height: 12,
      name: 'front-door-1.jpg', originalDimensions: { width: 32, height: 24 },
    })
  })
})

describe('classificationPrompt', () => {
  it('states the alert, camera, time, and frame offsets and asks for one JSON object', () => {
    expect(classificationPrompt({ kind: 'ding', deviceLabel: 'Front door', localTime: '2026-09-27 12:00:00', offsetsMs: [0, 10_400, 21_000] })).toBe([
      'Classify this doorbell press from the Front door camera at 2026-09-27 12:00:00. The 3 images are frames in capture order, taken 0 s, 10 s, 21 s after the alert.',
      '',
      'Reply with only one JSON object and no other text:',
      '{"labels":[],"counts":{},"activity":"none","vehicleActivity":"none","confidence":0,"description":"","personFrames":[]}',
      '',
      '- labels: each of "person", "vehicle", "package", "animal" visible in any frame.',
      '- counts: the most of each label visible at once, for example {"person":1}.',
      '- activity: one of "delivering", "lingering", "passing", "ringing", "none".',
      '- vehicleActivity: "arriving" or "leaving" when a vehicle drives into or out of the driveway or a parking spot across the frames, '
        + '"passing" when one drives by without stopping, "parked" when every vehicle stays still (lights or a running engine do not count as moving), '
        + '"none" when no vehicle is visible.',
      '- confidence: how sure you are, from 0 to 1.',
      '- description: one sentence of at most 25 words about what is happening. Do not guess who anyone is.',
      '- personFrames: zero-based indices of the frames that show a person.',
    ].join('\n'))
    expect(classificationPrompt({ kind: 'motion', deviceLabel: 'Garage', localTime: 't', offsetsMs: [0] }))
      .toContain('Classify this motion alert from the Garage camera at t. The 1 image is a frame in capture order, taken 0 s after the alert.')
  })

  it('pairs with a short classification-only system prompt', () => {
    expect(CLASSIFICATION_SYSTEM_PROMPT).toBe([
      'You classify still frames from a home security camera.',
      'The user message states the alert and shows the frames. Reply with exactly the one JSON object it asks for and nothing else.',
      'You have no tools. Describe people only by what is visible and never guess who anyone is.',
    ].join('\n'))
  })
})

describe('parseVerdict', () => {
  it('reads a complete verdict', () => {
    expect(parseVerdict('{"labels":["person","package"],"counts":{"person":1,"package":1},"activity":"delivering","vehicleActivity":"none",'
      + '"confidence":0.82,"description":"A courier sets a box by the door.","personFrames":[0,1]}', 3)).toEqual({
      status: 'parsed',
      verdict: { labels: ['person', 'package'], counts: { person: 1, package: 1 }, activity: 'delivering', vehicleActivity: 'none', confidence: 0.82,
        description: 'A courier sets a box by the door.', personFrames: [0, 1] },
    })
  })

  it('reads the vehicle activity and adds the vehicle label a moving or parked vehicle implies', () => {
    const answer = (vehicleActivity: unknown): string => JSON.stringify({ labels: [], counts: {}, activity: 'none', vehicleActivity,
      confidence: 0.9, description: 'x', personFrames: [] })
    expect(parseVerdict(answer('Arriving'), 1)).toMatchObject({ status: 'parsed', verdict: { labels: ['vehicle'], vehicleActivity: 'arriving' } })
    expect(parseVerdict(answer('parked'), 1)).toMatchObject({ status: 'parsed', verdict: { labels: ['vehicle'], vehicleActivity: 'parked' } })
    expect(parseVerdict(answer('none'), 1)).toMatchObject({ status: 'parsed', verdict: { labels: [], vehicleActivity: 'none' } })
    expect(parseVerdict(answer('unknown'), 1)).toMatchObject({ status: 'partial', verdict: { labels: [], vehicleActivity: 'unknown' } })
    expect(parseVerdict(answer('reversing'), 1)).toMatchObject({ status: 'partial', verdict: { vehicleActivity: 'unknown' } })
    expect(parseVerdict(answer(undefined), 1)).toMatchObject({ status: 'partial', verdict: { vehicleActivity: 'unknown' } })
  })

  it('finds the object inside fences and prose, skipping braces in strings and invalid candidates', () => {
    const text = 'Sure! {not json} Here it is:\n```json\n{"labels":["People","cars","boxes","Dogs"],"counts":{"people":2,"car":1,"truck":2},'
      + '"activity":"Passing","vehicleActivity":"parked","confidence":"85%","description":"Two people {walk} past\\n a \\"car\\".","personFrames":[2,0,0]}\n```'
    expect(parseVerdict(text, 3)).toEqual({
      status: 'parsed',
      verdict: { labels: ['person', 'vehicle', 'package', 'animal'], counts: { person: 2, vehicle: 2 }, activity: 'passing', vehicleActivity: 'parked', confidence: 0.85,
        description: 'Two people {walk} past a "car".', personFrames: [0, 2] },
    })
  })

  it('keeps what it can from a partial answer', () => {
    expect(parseVerdict('{"labels":["person","ghost",3],"counts":{"person":-1,"alien":1,"package":0,"animal":150},"activity":"dancing",'
      + '"confidence":250,"personFrames":[1,7,"x"]}', 2)).toEqual({
      status: 'partial',
      verdict: { labels: ['person', 'animal'], counts: { package: 0, animal: 99 }, activity: 'unknown', vehicleActivity: 'unknown', confidence: 0,
        description: 'Visible: person, animal.', personFrames: [1] },
    })
    expect(parseVerdict('{"labels":"person","counts":[],"confidence":"high","description":"   "}', 1)).toEqual({
      status: 'partial',
      verdict: { labels: [], counts: {}, activity: 'unknown', vehicleActivity: 'unknown', confidence: 0, description: 'Nothing identified.', personFrames: [] },
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
  personDevices: [], vehicleDevices: ['garage'], vehicleActivities: ['arriving', 'leaving'], lingerMs: 20_000, minConfidence: 0.5,
}

function verdict(fields: Partial<CameraVerdict>): CameraVerdict {
  return { labels: [], counts: {}, activity: 'none', vehicleActivity: 'none', confidence: 0.9, description: 'x', personFrames: [], ...fields }
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

  it('notifies any person on a person device at any hour, keeping night-person beside it', () => {
    const doorPolicy = { ...policy, personDevices: ['front-door'] }
    const visitor = verdict({ labels: ['person'], activity: 'passing', personFrames: [0] })
    expect(noticeReasons(event(), visitor, 'parsed', doorPolicy, TZ)).toEqual(['person'])
    expect(noticeReasons(event({ deviceId: 'garage' }), visitor, 'parsed', doorPolicy, TZ)).toEqual([])
    expect(noticeReasons(event(), { ...visitor, confidence: 0.4 }, 'parsed', doorPolicy, TZ)).toEqual([])
    expect(noticeReasons(event(), verdict({ labels: ['animal'] }), 'parsed', doorPolicy, TZ)).toEqual([])
    expect(noticeReasons(event({ occurredAt: NIGHT }), visitor, 'parsed', doorPolicy, TZ)).toEqual(['night-person', 'person'])
    expect(noticeReasons(event({ occurredAt: NIGHT }), visitor, 'parsed', { ...doorPolicy, nightPerson: false }, TZ)).toEqual(['person'])
  })

  it('notifies an arriving or leaving vehicle only on configured devices, never a parked one', () => {
    const car = (vehicleActivity: CameraVerdict['vehicleActivity']): CameraVerdict => verdict({ labels: ['vehicle'], counts: { vehicle: 1 }, vehicleActivity })
    expect(noticeReasons(event({ deviceId: 'garage' }), car('arriving'), 'parsed', policy, TZ)).toEqual(['vehicle'])
    expect(noticeReasons(event({ deviceId: 'garage' }), car('leaving'), 'partial', policy, TZ)).toEqual(['vehicle'])
    expect(noticeReasons(event(), car('arriving'), 'parsed', policy, TZ)).toEqual([])
    for (const quiet of ['parked', 'passing', 'unknown', 'none'] as const) {
      expect(noticeReasons(event({ deviceId: 'garage' }), car(quiet), 'parsed', policy, TZ)).toEqual([])
    }
    expect(noticeReasons(event({ deviceId: 'garage' }), car('passing'), 'parsed', { ...policy, vehicleActivities: ['passing'] }, TZ)).toEqual(['vehicle'])
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
      verdict: verdict({ description: 'A courier with a box.', counts: { person: 1, package: 1, animal: 0 }, confidence: 0.834, vehicleActivity: 'leaving' }) })).toBe([
      '**Front door** · 23:30: Doorbell rang; Package delivered; Person at night; Vehicle leaving; Someone lingering (21 s)',
      'A courier with a box.',
      'Seen: person 1, package 1 · confidence 83%',
    ].join('\n'))
    expect(renderNotice({ ...base, reasons: ['ding'], status: 'partial', verdict: verdict({ description: 'Nothing identified.', confidence: 0 }) }))
      .toContain('Nothing counted · confidence 0%')
    expect(renderNotice({ ...base, reasons: ['vehicle'], status: 'failed' }).split('\n')[0]).toBe('**Front door** · 23:30: Vehicle seen')
  })

  it('names the camera for a person, and lets the night headline stand for both person reasons', () => {
    const facts = { ...base, status: 'parsed' as const, verdict: verdict({ description: 'A visitor.', counts: { person: 1 } }) }
    expect(renderNotice({ ...facts, occurredAt: NOON, reasons: ['person'] }).split('\n')[0]).toBe('**Front door** · 12:00: Person at Front door')
    expect(renderNotice({ ...facts, reasons: ['night-person', 'person', 'lingering'], lingerSeconds: 25 }).split('\n')[0])
      .toBe('**Front door** · 23:30: Person at night; Someone lingering (25 s)')
  })

  it('announces a doorbell press before classification', () => {
    expect(renderDingNotice(base)).toBe('**Front door** · 23:30: Someone rang the doorbell')
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
