import { describe, expect, it } from 'vitest'
import { CameraDeviceId } from '@deepseek-ai/dsh-camera'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { HistoryRecord } from '../src/history.ts'
import { CAMERA_TOOL_NAME, createCameraTool } from '../src/tool.ts'
import { NIGHT, NOON } from './support.ts'

function table(records: readonly HistoryRecord[]): Pick<KvTable<string, HistoryRecord>, 'entries'> {
  const map = new Map(records.map(record => [record.eventId, record]))
  return { entries: () => map.entries() }
}

function record(fields: Partial<HistoryRecord> & Pick<HistoryRecord, 'eventId' | 'occurredAt'>): HistoryRecord {
  return { deviceId: 'front-door', kind: 'motion', frames: [], status: 'parsed', reasons: [], delivery: 'none', ...fields }
}

const frame = { attachmentId: 'sha256:a', mediaType: 'image/jpeg' as const, bytes: 1, width: 1, height: 1, offsetMs: 0, source: 'snapshot' as const }

const history = [
  record({ eventId: 'ding', occurredAt: NIGHT, kind: 'ding', frames: [frame], reasons: ['ding'], delivery: 'delivered',
    verdict: { labels: ['person'], counts: { person: 1 }, description: 'A visitor rings.',
      answers: { person_on_property: { answer: true, frames: [0] }, person_at_door: { answer: true, frames: [0] },
        package_being_delivered: { answer: false, frames: [] } } } }),
  record({ eventId: 'car', occurredAt: NIGHT - 60_000, deviceId: 'garage', frames: [frame], status: 'unparsed', text: 'A car, I think.' }),
  record({ eventId: 'dark', occurredAt: NIGHT - 120_000, kind: 'ding', status: 'skipped', failure: 'NO_FRAMES', reasons: ['ding'], delivery: 'undelivered' }),
  record({ eventId: 'blind', occurredAt: NIGHT - 180_000, kind: 'ding', frames: [frame], status: 'failed', failure: 'TIMEOUT', reasons: ['ding'],
    delivery: 'undelivered', earlyDelivery: 'delivered' }),
  record({ eventId: 'stray', occurredAt: NIGHT - 240_000, deviceId: 'porch' }),
  record({ eventId: 'old', occurredAt: NOON - 3 * 86_400_000 }),
  record({ eventId: 'legacy', occurredAt: NIGHT - 300_000, deviceId: 'garage', verdict: { labels: ['vehicle'], counts: { vehicle: 2 }, description: 'Two parked cars.',
    answers: {}, activity: 'none', vehicleActivity: 'parked', confidence: 0.95, personFrames: [] } }),
  record({ eventId: 'oldest', occurredAt: NIGHT - 360_000, verdict: { labels: [], counts: {}, description: 'An empty path.', answers: {}, activity: 'none' } }),
]

const exec = {} as ToolRunContext

function tool(maxEvents = 50) {
  return createCameraTool({
    table: table(history), devices: [{ id: CameraDeviceId('front-door'), label: 'Front door' }, { id: CameraDeviceId('garage'), label: 'Garage' }],
    timezone: 'America/Phoenix', maxEvents, maxHours: 720, now: () => NIGHT + 1_000,
  })
}

interface Listing { total: number; from: string; to: string; timezone: string; events: Record<string, unknown>[] }

async function read(args: Record<string, unknown>, maxEvents?: number): Promise<Listing> {
  const result = await tool(maxEvents).execute(args, exec) as { text: string }
  return JSON.parse(result.text) as Listing
}

describe('camera tool', () => {
  it('describes a read-only history tool with a device enum', () => {
    const definition = tool()
    expect(definition.name).toBe(CAMERA_TOOL_NAME)
    expect(definition.description).toBe('Read what the home cameras recorded: doorbell presses and motion events with the time, the camera, '
      + 'what the vision check saw (people, vehicles, packages, animals), a one-line description, and whether the user was notified. '
      + 'Times are local to America/Phoenix. Use it for questions such as what happened at the door today. '
      + 'It cannot show live video, take new pictures, or say who someone is.')
    expect(definition.parameters).toMatchObject({ properties: { camera: { type: 'string', enum: ['front-door', 'garage'] } } })
    expect(definition.presentCall?.({ hours: 2 })).toEqual({ card: 'generic', title: 'Camera events', kind: 'read', rawInput: '{"hours":2}' })
    expect(definition.output?.render({}, { text: 'x' })).toEqual([{ type: 'text', text: 'x' }])
  })

  it('lists events newest first within the default day, with descriptions for every status', async () => {
    const result = await read({})
    expect(result).toMatchObject({ timezone: 'America/Phoenix', from: '2026-09-26 23:30:01', to: '2026-09-27 23:30:01', total: 7 })
    expect(result.events).toEqual([
      { id: 'ding', time: '2026-09-27 23:30:00', camera: 'Front door', kind: 'ding', description: 'A visitor rings.', labels: ['person'],
        counts: { person: 1 }, answers: { person_on_property: true, person_at_door: true, package_being_delivered: false }, checked: 'parsed',
        notified: true, reasons: ['ding'] },
      { id: 'car', time: '2026-09-27 23:29:00', camera: 'Garage', kind: 'motion', description: 'A car, I think.', labels: [], counts: {},
        checked: 'unparsed', notified: false, reasons: [] },
      { id: 'dark', time: '2026-09-27 23:28:00', camera: 'Front door', kind: 'ding', description: 'No picture was captured.', labels: [], counts: {},
        checked: 'skipped (NO_FRAMES)', notified: false, reasons: ['ding'] },
      { id: 'blind', time: '2026-09-27 23:27:00', camera: 'Front door', kind: 'ding', description: 'Not described.', labels: [], counts: {},
        checked: 'failed (TIMEOUT)', notified: true, reasons: ['ding'] },
      { id: 'stray', time: '2026-09-27 23:26:00', camera: 'porch', kind: 'motion', description: 'No picture was captured.', labels: [], counts: {},
        checked: 'parsed', notified: false, reasons: [] },
      { id: 'legacy', time: '2026-09-27 23:25:00', camera: 'Garage', kind: 'motion', description: 'Two parked cars.', labels: ['vehicle'],
        counts: { vehicle: 2 }, activity: 'none', vehicleActivity: 'parked', confidence: 0.95, checked: 'parsed', notified: false, reasons: [] },
      { id: 'oldest', time: '2026-09-27 23:24:00', camera: 'Front door', kind: 'motion', description: 'An empty path.', labels: [], counts: {},
        activity: 'none', checked: 'parsed', notified: false, reasons: [] },
    ])
  })

  it('filters by camera, notification, window, and limit', async () => {
    expect((await read({ camera: 'garage' })).events.map(event => event.id)).toEqual(['car', 'legacy'])
    expect((await read({ notified_only: true })).events.map(event => event.id)).toEqual(['ding', 'blind'])
    expect((await read({ hours: 100 })).total).toBe(8)
    const limited = await read({ limit: 2 })
    expect([limited.total, limited.events.length]).toEqual([7, 2])
    expect((await read({ limit: 3 }, 3)).events).toHaveLength(3)
  })

  it.each([
    [{ hours: 0 }, /hours must be an integer from 1 through 720/],
    [{ hours: 721 }, /hours must be/],
    [{ hours: 1.5 }, /integer/],
    [{ limit: 0 }, /limit must be an integer from 1 through 50/],
    [{ limit: 51 }, /limit must be/],
    [{ limit: 2.5 }, /integer/],
  ])('rejects %j', async (args, message) => {
    await expect(tool().execute(args, exec)).rejects.toThrow(message)
  })
})
