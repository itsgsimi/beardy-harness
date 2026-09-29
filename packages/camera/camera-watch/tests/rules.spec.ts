import { describe, expect, it } from 'vitest'
import type { CameraVerdict } from '@deepseek-ai/dsh-camera'
import { Config as ConfigSchema, resolveConfig, WATCH_DEFAULTS } from '../src/config.ts'
import type { Config, ResolvedPolicy } from '../src/config.ts'
import { deviceBaseline, frameAttachment, historyRecord, partitionHistory, storedVerdict } from '../src/history.ts'
import type { HistoryFrame, HistoryRecord } from '../src/history.ts'
import { FIRST_FRAME_LINE, localDateTime, renderDingNotice, renderNotice } from '../src/notice.ts'
import { addsToEarlyNotice, insideWindow, lingeringMs, localMinute, noticeReasons, personFrames, vehicleChange } from '../src/policy.ts'
import type { PolicyEvent } from '../src/policy.ts'
import { NIGHT, NOON } from './support.ts'

const TZ = 'America/Phoenix'

describe('resolveConfig', () => {
  it('applies every package default', () => {
    const resolved = resolveConfig({ timezone: TZ })
    expect(resolved).toEqual({
      timezone: TZ,
      policy: { ding: true, packageDelivered: true, nightPerson: true, nightStartMinute: 21 * 60, nightEndMinute: 6 * 60,
        personDevices: [], doorDevices: [], vehicleDevices: [], vehicleActivities: ['arriving', 'leaving'], lingerMs: 20_000,
        arrivalBaselineMs: 43_200_000 },
      scenes: new Map(),
      immediateDingNotice: true, earlyMotionNotice: true, maxOutputTokens: 600, turnTimeoutMs: 120_000, maxConcurrent: 1, maxQueued: 10,
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
      policy: { ding: false, packageDelivered: false, nightPerson: false, nightStart: '22:15', nightEnd: '05:45', personDevices: ['front-door', 'front-door'],
        doorDevices: ['front-door', 'front-door'], vehicleDevices: ['garage', 'garage'],
        vehicleActivities: ['leaving', 'leaving'], lingerSeconds: 30, minConfidence: 0.7, arrivalBaselineMs: 0 },
      devices: [{ id: 'front-door', scene: '  Door at the right edge.\n' }, { id: 'garage' }],
      immediateDingNotice: false, earlyMotionNotice: false, maxOutputTokens: 100, turnTimeoutMs: 9_000, maxConcurrent: 2, maxQueued: 3,
      retentionDays: 2, maxHistory: 9,
      sweepIntervalMs: 70_000, deliveryAttempts: 5, deliveryRetryMs: 2_000, failureNoticeThreshold: 1, failureNoticeIntervalMs: 60_000,
      tool: false, toolMaxEvents: 7,
    }
    expect(resolveConfig(config)).toEqual({
      timezone: 'UTC', modelSelection: { provider: 'mock', model: 'vision', reasoningEffort: 'low' }, deliverChannelId: '123456789012345678',
      workspacePath: '/srv/beardy',
      policy: { ding: false, packageDelivered: false, nightPerson: false, nightStartMinute: 22 * 60 + 15, nightEndMinute: 5 * 60 + 45,
        personDevices: ['front-door'], doorDevices: ['front-door'], vehicleDevices: ['garage'], vehicleActivities: ['leaving'], lingerMs: 30_000,
        arrivalBaselineMs: 0 },
      scenes: new Map([['front-door', 'Door at the right edge.']]),
      immediateDingNotice: false, earlyMotionNotice: false, maxOutputTokens: 100, turnTimeoutMs: 9_000, maxConcurrent: 2, maxQueued: 3,
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
    [{ timezone: TZ, devices: [{ id: 'garage' }, { id: 'garage', scene: 'x' }] }, /devices lists "garage" twice/],
    [{ timezone: TZ, devices: [{ id: 'garage', scene: '  ' }] }, /devices "garage" scene must be 1 to 1000 characters/],
    [{ timezone: TZ, devices: [{ id: 'garage', scene: 'x'.repeat(1_001) }] }, /scene must be 1 to 1000/],
    [{ timezone: TZ, earlyMotionNotice: false, earlyModelSelection: { provider: 'mock', model: 'fast' } }, /earlyModelSelection needs earlyMotionNotice/],
  ] as [Config, RegExp][])('rejects %j', (config, message) => {
    expect(() => resolveConfig(config)).toThrow(message)
  })

  it('keeps a separate first-frame route', () => {
    const early = { provider: 'mock', model: 'fast', reasoningEffort: 'off' } as const
    expect(ConfigSchema({ timezone: TZ, earlyModelSelection: early }).earlyModelSelection).toEqual(early)
    expect(resolveConfig({ timezone: TZ, earlyModelSelection: early }).earlyModelSelection).toEqual(early)
    expect(resolveConfig({ timezone: TZ })).not.toHaveProperty('earlyModelSelection')
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

  it('bounds the arrival baseline window from off to one week', () => {
    expect(ConfigSchema({ timezone: TZ, policy: { arrivalBaselineMs: 0 } }).policy?.arrivalBaselineMs).toBe(0)
    expect(ConfigSchema({ timezone: TZ }).policy?.arrivalBaselineMs).toBe(43_200_000)
    expect(ConfigSchema({ timezone: TZ }).earlyMotionNotice).toBe(true)
    expect(() => ConfigSchema({ timezone: TZ, policy: { arrivalBaselineMs: -1 } })).toThrow()
    expect(() => ConfigSchema({ timezone: TZ, policy: { arrivalBaselineMs: 604_800_001 } })).toThrow()
  })

  it('accepts only the arriving and leaving vehicle movements', () => {
    expect(ConfigSchema({ timezone: TZ }).policy?.vehicleActivities).toEqual(['arriving', 'leaving'])
    for (const activity of ['none', 'parked', 'passing']) {
      expect(() => ConfigSchema({ timezone: TZ, policy: { vehicleActivities: [activity] } } as never)).toThrow()
    }
  })

  it('keeps a configured minConfidence out of the schema defaults and the resolved rules', () => {
    expect(ConfigSchema({ timezone: TZ }).policy).not.toHaveProperty('minConfidence')
    expect(ConfigSchema({ timezone: TZ, policy: { minConfidence: 0.7 } }).policy?.minConfidence).toBe(0.7)
    expect(() => ConfigSchema({ timezone: TZ, policy: { minConfidence: 1.5 } })).toThrow()
    expect(resolveConfig({ timezone: TZ, policy: { minConfidence: 0.7 } }).policy).not.toHaveProperty('minConfidence')
  })
})

describe('historyRecord', () => {
  const legacy = { labels: ['vehicle'], counts: { vehicle: 3 }, activity: 'none', confidence: 0.9, description: 'Three parked cars.', personFrames: [] }

  it('reads verdicts stored before rule questions with empty answers and keeps their own fields', () => {
    const stored = {
      eventId: 'old', deviceId: 'garage', kind: 'motion', occurredAt: NOON, frames: [], status: 'parsed', reasons: [], delivery: 'none', verdict: legacy,
    }
    expect(historyRecord.parse(stored).verdict).toEqual({ ...legacy, answers: {} })
    expect(historyRecord.parse({ ...stored, verdict: { ...legacy, vehicleActivity: 'parked' } }).verdict?.vehicleActivity).toBe('parked')
    expect(historyRecord.parse({ ...stored, captureFailure: 'snapshot-stale', earlyDelivery: 'delivered' }))
      .toMatchObject({ captureFailure: 'snapshot-stale', earlyDelivery: 'delivered' })
  })

  it('reads verdicts with answers and rejects unknown questions', () => {
    const answers = { person_on_property: { answer: true, frames: [0, 2] }, vehicle_arriving: { answer: false, frames: [] } }
    const stored = {
      eventId: 'new', deviceId: 'garage', kind: 'motion', occurredAt: NOON, frames: [], status: 'parsed', reasons: [], delivery: 'none',
      verdict: { labels: ['person'], counts: { person: 1 }, description: 'A person walks up the driveway.', answers },
    }
    expect(historyRecord.parse(stored).verdict).toEqual(stored.verdict)
    const unknown = { ...stored.verdict, answers: { person_lurking: { answer: true, frames: [0] } } }
    expect(historyRecord.safeParse({ ...stored, verdict: unknown }).success).toBe(false)
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

  it('reads records without and with the early check and vehicle movement fields', () => {
    const stored = { eventId: 'e', deviceId: 'garage', kind: 'motion', occurredAt: NOON, frames: [], status: 'parsed', reasons: ['vehicle'], delivery: 'none' }
    expect(historyRecord.parse(stored)).not.toHaveProperty('earlyReasons')
    const extended = { ...stored, earlyDelivery: 'delivered', earlySessionId: 'camera-garage-1', earlyReasons: ['vehicle'],
      vehicleChange: 'arriving', baselineEventId: 'before' }
    expect(historyRecord.parse(extended)).toMatchObject(extended)
    expect(historyRecord.safeParse({ ...extended, vehicleChange: 'parked' }).success).toBe(false)
  })

  it('stores a verdict as a copy', () => {
    const answers = { package_present: { answer: true, frames: [1] } }
    const stored = storedVerdict({ labels: ['package'], counts: { package: 1 }, description: 'A box by the door.', answers })
    expect(stored).toEqual({ labels: ['package'], counts: { package: 1 }, description: 'A box by the door.', answers })
    expect(stored.answers.package_present?.frames).not.toBe(answers.package_present.frames)
  })
})

describe('deviceBaseline', () => {
  const HOUR = 3_600_000
  const parked: HistoryRecord['verdict'] = { labels: ['vehicle'], counts: { vehicle: 2 }, description: 'x', answers: {} }
  const record = (eventId: string, fields: Partial<HistoryRecord>): [string, HistoryRecord] => [eventId, {
    eventId, deviceId: 'garage', kind: 'motion', occurredAt: NOON - HOUR, frames: [], status: 'parsed', reasons: [], delivery: 'none',
    verdict: parked, ...fields,
  }]

  it('picks the latest earlier verdict of the same device inside the window, stored before rule questions or after', () => {
    const entries = [
      record('older', { occurredAt: NOON - 3 * HOUR }),
      record('latest', {}),
      record('failed', { occurredAt: NOON - 20 * 60_000, status: 'failed', verdict: undefined }),
      record('front', { occurredAt: NOON - 10 * 60_000, deviceId: 'front-door' }),
      record('same-time', { occurredAt: NOON }),
      record('later', { occurredAt: NOON + HOUR }),
    ]
    expect(deviceBaseline(entries, 'garage', NOON, 12 * HOUR)).toEqual({ eventId: 'latest', occurredAt: NOON - HOUR, verdict: parked })
    expect(deviceBaseline([...entries].reverse(), 'garage', NOON, 12 * HOUR)?.eventId).toBe('latest')
    expect(deviceBaseline(entries, 'garage', NOON, HOUR - 1)).toBeUndefined()
    const legacy = historyRecord.parse({ ...record('legacy', {})[1], occurredAt: NOON - 60_000,
      verdict: { labels: [], counts: {}, activity: 'none', confidence: 0.2, description: 'Empty.', personFrames: [] } })
    expect(deviceBaseline([...entries, ['legacy', legacy]], 'garage', NOON, 12 * HOUR)?.eventId).toBe('legacy')
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

const policy: ResolvedPolicy = {
  ding: true, packageDelivered: true, nightPerson: true, nightStartMinute: 21 * 60, nightEndMinute: 6 * 60,
  personDevices: [], doorDevices: [], vehicleDevices: ['garage'], vehicleActivities: ['arriving', 'leaving'], lingerMs: 20_000,
  arrivalBaselineMs: 43_200_000,
}

type Answers = CameraVerdict['answers']

function verdict(fields: Partial<CameraVerdict>): CameraVerdict {
  return { labels: [], counts: {}, description: 'x', answers: {}, ...fields }
}

/** A verdict whose listed questions are answered true with the given evidence frames. */
function said(answers: Readonly<Record<string, readonly number[]>>, fields: Partial<CameraVerdict> = {}): CameraVerdict {
  const entries = Object.entries(answers).map(([question, frames]) => [question, { answer: true, frames }])
  return verdict({ answers: Object.fromEntries(entries) as Answers, ...fields })
}

function event(fields: Partial<PolicyEvent> = {}): PolicyEvent {
  return { kind: 'motion', deviceId: 'front-door', occurredAt: NOON, offsetsMs: [0, 10_000, 21_000], ...fields }
}

describe('vehicleChange', () => {
  it('reads more vehicles as arriving, fewer as leaving, and equal counts as no movement', () => {
    expect(vehicleChange(verdict({ counts: { vehicle: 3 } }), verdict({ counts: { vehicle: 2 } }))).toBe('arriving')
    expect(vehicleChange(verdict({ counts: {} }), verdict({ counts: { vehicle: 1 } }))).toBe('leaving')
    expect(vehicleChange(verdict({ counts: { vehicle: 2 } }), verdict({ counts: { vehicle: 2 } }))).toBeUndefined()
    expect(vehicleChange(verdict({ counts: { vehicle: 1 } }), verdict({ counts: {} }))).toBe('arriving')
  })
})

describe('addsToEarlyNotice', () => {
  const early = { reasons: ['person' as const], verdict: verdict({ labels: ['person'], counts: { person: 1 } }) }

  it('adds a reason the early notice did not state or a higher count of any label', () => {
    expect(addsToEarlyNotice(early, ['person', 'lingering'], verdict({ counts: { person: 1 } }))).toBe(true)
    expect(addsToEarlyNotice(early, ['person'], verdict({ counts: { person: 2 } }))).toBe(true)
    expect(addsToEarlyNotice(early, ['person'], verdict({ counts: { person: 1, package: 1 } }))).toBe(true)
  })

  it('adds nothing for the same reasons and counts, fewer reasons, or no verdict', () => {
    expect(addsToEarlyNotice(early, ['person'], verdict({ counts: { person: 1 }, description: 'Worded differently.' }))).toBe(false)
    expect(addsToEarlyNotice(early, [], verdict({ counts: { person: 3 } }))).toBe(false)
    expect(addsToEarlyNotice(early, ['person'], undefined)).toBe(false)
    expect(addsToEarlyNotice(early, ['person'], verdict({ counts: { person: 0 } }))).toBe(false)
  })
})

describe('noticeReasons', () => {
  const reasons = (...args: Parameters<typeof noticeReasons>): string[] => noticeReasons(...args).reasons

  it('notifies every doorbell press, with or without a verdict', () => {
    expect(noticeReasons(event({ kind: 'ding' }), undefined, 'failed', policy, TZ)).toEqual({ reasons: ['ding'] })
    expect(reasons(event({ kind: 'ding' }), verdict({}), 'parsed', policy, TZ)).toEqual(['ding'])
    expect(reasons(event({ kind: 'ding' }), undefined, 'skipped', { ...policy, ding: false }, TZ)).toEqual([])
  })

  it('notifies a package being delivered, or a present package the baseline answered absent', () => {
    expect(reasons(event(), said({ package_being_delivered: [0] }), 'parsed', policy, TZ)).toEqual(['package'])
    expect(reasons(event(), said({ package_present: [1] }), 'parsed', policy, TZ)).toEqual([])
    expect(reasons(event(), said({ package_present: [1] }), 'parsed', policy, TZ, { packageAbsent: false })).toEqual([])
    expect(reasons(event(), said({ package_present: [1] }), 'parsed', policy, TZ, { packageAbsent: true })).toEqual(['package'])
    expect(reasons(event(), verdict({ labels: ['package'], counts: { package: 1 } }), 'parsed', policy, TZ, { packageAbsent: true })).toEqual([])
    expect(reasons(event(), said({ package_being_delivered: [0] }), 'parsed', { ...policy, packageDelivered: false }, TZ)).toEqual([])
  })

  it('notifies a person on the property inside the night window across midnight, not a sidewalk passer-by', () => {
    const night = said({ person_on_property: [0] }, { labels: ['person'] })
    expect(reasons(event({ occurredAt: NIGHT }), night, 'parsed', policy, TZ)).toEqual(['night-person'])
    expect(reasons(event({ occurredAt: Date.UTC(2026, 8, 28, 12, 59) }), night, 'parsed', policy, TZ)).toEqual(['night-person'])
    expect(reasons(event({ occurredAt: Date.UTC(2026, 8, 28, 13, 0) }), night, 'parsed', policy, TZ)).toEqual([])
    expect(reasons(event(), night, 'parsed', policy, TZ)).toEqual([])
    const sidewalk = verdict({ labels: ['person'], counts: { person: 1 }, answers: { person_on_property: { answer: false, frames: [] } } })
    expect(reasons(event({ occurredAt: NIGHT }), sidewalk, 'parsed', policy, TZ)).toEqual([])
    expect(reasons(event({ occurredAt: NIGHT }), night, 'parsed', { ...policy, nightPerson: false }, TZ)).toEqual([])
  })

  it('notifies a person on the property or at the door of a person device at any hour, keeping night-person beside it', () => {
    const doorPolicy = { ...policy, personDevices: ['front-door', 'garage'] }
    const driveway = said({ person_on_property: [0] })
    expect(reasons(event(), driveway, 'parsed', doorPolicy, TZ)).toEqual(['person'])
    expect(reasons(event({ deviceId: 'garage' }), driveway, 'parsed', doorPolicy, TZ)).toEqual(['person'])
    expect(reasons(event({ deviceId: 'garage' }), driveway, 'parsed', policy, TZ)).toEqual([])
    expect(reasons(event(), said({ person_at_door: [2] }), 'parsed', doorPolicy, TZ)).toEqual(['person'])
    const passerBy = verdict({ labels: ['person'], counts: { person: 1 }, answers: { person_on_property: { answer: false, frames: [] } } })
    expect(reasons(event({ deviceId: 'garage' }), passerBy, 'parsed', doorPolicy, TZ)).toEqual([])
    expect(reasons(event({ occurredAt: NIGHT }), driveway, 'parsed', doorPolicy, TZ)).toEqual(['night-person', 'person'])
    expect(reasons(event({ occurredAt: NIGHT }), driveway, 'parsed', { ...doorPolicy, nightPerson: false }, TZ)).toEqual(['person'])
  })

  it('notifies an arriving or leaving vehicle only on configured devices, from the answers or the count movement', () => {
    const garage = event({ deviceId: 'garage' })
    expect(noticeReasons(garage, said({ vehicle_arriving: [0] }), 'parsed', policy, TZ)).toEqual({ reasons: ['vehicle'], vehicle: 'arriving' })
    expect(noticeReasons(garage, said({ vehicle_leaving: [1] }), 'partial', policy, TZ)).toEqual({ reasons: ['vehicle'], vehicle: 'leaving' })
    expect(reasons(event(), said({ vehicle_arriving: [0] }), 'parsed', policy, TZ)).toEqual([])
    expect(reasons(garage, verdict({ labels: ['vehicle'], counts: { vehicle: 2 } }), 'parsed', policy, TZ)).toEqual([])
    expect(noticeReasons(garage, verdict({ counts: { vehicle: 2 } }), 'parsed', policy, TZ, { vehicleChange: 'arriving' }))
      .toEqual({ reasons: ['vehicle'], vehicle: 'arriving' })
    expect(noticeReasons(garage, said({ vehicle_arriving: [0] }), 'parsed', policy, TZ, { vehicleChange: 'leaving' }))
      .toEqual({ reasons: ['vehicle'], vehicle: 'leaving' })
    expect(noticeReasons(garage, said({ vehicle_arriving: [0] }), 'parsed', { ...policy, vehicleActivities: ['arriving'] }, TZ, { vehicleChange: 'leaving' }))
      .toEqual({ reasons: ['vehicle'], vehicle: 'arriving' })
    expect(reasons(garage, said({ vehicle_leaving: [0] }), 'parsed', { ...policy, vehicleActivities: ['arriving'] }, TZ)).toEqual([])
    expect(reasons(event(), verdict({}), 'parsed', policy, TZ, { vehicleChange: 'arriving' })).toEqual([])
  })

  it('notifies lingering from a staying person whose evidence frames span the threshold', () => {
    expect(reasons(event(), said({ person_staying: [0, 2] }), 'parsed', policy, TZ)).toEqual(['lingering'])
    expect(reasons(event(), said({ person_on_property: [0, 2] }), 'parsed', policy, TZ)).toEqual([])
    expect(reasons(event(), said({ person_staying: [0, 1] }), 'parsed', policy, TZ)).toEqual([])
    expect(reasons(event(), said({ person_staying: [2], person_on_property: [0] }), 'parsed', policy, TZ)).toEqual(['lingering'])
    expect(lingeringMs(event({ offsetsMs: [0, 5_000, 30_000] }), said({ person_on_property: [0, 1], person_at_door: [2] }))).toBe(30_000)
    expect(lingeringMs(event({ offsetsMs: [0] }), said({ person_on_property: [0, 3] }))).toBe(0)
  })

  it('stays quiet without a usable verdict', () => {
    const box = said({ package_being_delivered: [0] })
    expect(reasons(event(), box, 'partial', policy, TZ)).toEqual(['package'])
    expect(reasons(event(), undefined, 'unparsed', policy, TZ)).toEqual([])
    expect(reasons(event(), box, 'failed', policy, TZ)).toEqual([])
  })

  it('collects person evidence frames in order', () => {
    const frames = said({ person_on_property: [2, 0], person_at_door: [1], person_staying: [2], package_present: [3] })
    expect(personFrames(frames)).toEqual([0, 1, 2])
    expect(personFrames(verdict({}))).toEqual([])
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

  it('states device, time, reasons, description, and counts', () => {
    expect(renderNotice({ ...base, reasons: ['ding', 'package', 'night-person', 'vehicle', 'lingering'], status: 'parsed', lingerSeconds: 21,
      verdict: verdict({ description: 'A courier with a box.', counts: { person: 1, package: 1, animal: 0 } }), vehicle: 'leaving' })).toBe([
      '**Front door** · 23:30: Doorbell rang; Package delivered; Person at night; Vehicle leaving; Someone lingering (21 s)',
      'A courier with a box.',
      'Seen: person 1, package 1',
    ].join('\n'))
    expect(renderNotice({ ...base, reasons: ['ding'], status: 'partial', verdict: verdict({ description: 'Nothing identified.' }) }))
      .toContain('Nothing counted')
    expect(renderNotice({ ...base, reasons: ['vehicle'], status: 'failed' }).split('\n')[0]).toBe('**Front door** · 23:30: Vehicle moving')
  })

  it('names the camera for a person, and lets the night headline stand for both person reasons', () => {
    const facts = { ...base, status: 'parsed' as const, verdict: verdict({ description: 'A visitor.', counts: { person: 1 } }) }
    expect(renderNotice({ ...facts, occurredAt: NOON, reasons: ['person'] }).split('\n')[0]).toBe('**Front door** · 12:00: Person at Front door')
    expect(renderNotice({ ...facts, reasons: ['night-person', 'person', 'lingering'], lingerSeconds: 25 }).split('\n')[0])
      .toBe('**Front door** · 23:30: Person at night; Someone lingering (25 s)')
  })

  it('names the vehicle movement in the headline and marks early and update notices', () => {
    const car = verdict({ description: 'A dark SUV stands with its door open.', counts: { vehicle: 3 } })
    expect(renderNotice({ ...base, deviceLabel: 'Garage', reasons: ['vehicle'], status: 'parsed', verdict: car, vehicle: 'arriving', stage: 'update' }))
      .toBe('**Garage** · 23:30 (update): Vehicle arriving\nA dark SUV stands with its door open.\nSeen: vehicle 3')
    expect(renderNotice({ ...base, reasons: ['person'], status: 'parsed', verdict: verdict({ description: 'A visitor.', counts: { person: 1 } }), stage: 'first-frame' }))
      .toBe(`**Front door** · 23:30: Person at Front door\nA visitor.\nSeen: person 1\n${FIRST_FRAME_LINE}`)
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
