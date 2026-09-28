import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { cameraWatchDomainSpec, historyRecord } from '../src/history.ts'
import type { HistoryRecord } from '../src/history.ts'
import { NIGHT, NOON, until, verdictText, watchHarness } from './support.ts'
import type { WatchHarness } from './support.ts'

const harnesses: WatchHarness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose()
})

async function start(...args: Parameters<typeof watchHarness>): Promise<WatchHarness> {
  const harness = await watchHarness(...args)
  harnesses.push(harness)
  return harness
}

const records = new WeakMap<WatchHarness, Map<string, HistoryRecord>>()
const written = new WeakMap<WatchHarness, Set<string>>()

function recordOf(harness: WatchHarness, id: string): HistoryRecord | undefined {
  return records.get(harness)?.get(id)
}

/** Mirror every committed history write so tests can read records without reopening the domain. */
function mirror(harness: WatchHarness): void {
  const seen = new Map<string, HistoryRecord>()
  const ever = new Set<string>()
  records.set(harness, seen)
  written.set(harness, ever)
  harness.ctx.on('domain/changed', (change) => {
    if (change.domain !== cameraWatchDomainSpec.name || change.table !== 'events') return
    if (change.operation === 'deleted') seen.delete(change.key)
    else {
      seen.set(change.key, historyRecord.parse(change.value))
      ever.add(change.key)
    }
  })
}

function userText(request: GenerateOptions): string {
  const message = request.messages.findLast(item => item.role === 'user' && item.content.some(block => block.type === 'image'))
  return message?.content.map(block => block.type === 'text' ? block.text : `[${block.type}]`).join('|') ?? ''
}

describe('camera watch classification', () => {
  it('logs one tool-free classification turn with the frames and delivers a doorbell notice with the person frame', async () => {
    const harness = await start([verdictText({ labels: ['person'], counts: { person: 1 }, activity: 'ringing', confidence: 0.91,
      description: 'A person in a grey hoodie presses the doorbell.', personFrames: [1] })], { workspacePath: '/srv/beardy' })
    mirror(harness)
    const frames = await harness.frames(3, [0, 10_000, 20_000])
    await harness.camera.send(harness.event('ding', frames, { id: 'ring-101-900' }))
    await until(() => recordOf(harness, 'ring-101-900')?.delivery === 'delivered', 'delivered ding')
    const [request] = harness.adapter.requests
    expect(request?.tools ?? []).toEqual([])
    expect(request?.model).toBe('vision-model')
    expect(request?.maxTokens).toBe(600)
    const prompt = userText(request!)
    expect(prompt.startsWith('Classify this doorbell press from the Front door camera at 2026-09-27 12:00:00. ')).toBe(true)
    expect(prompt.endsWith('|[image]|[image]|[image]')).toBe(true)
    const log = await harness.sessionLog()
    const header = log.find(entry => entry.type === 'session')
    expect(header).toMatchObject({ cwd: '/srv/beardy' })
    const user = log.find(entry => entry.type === 'user/message' && JSON.stringify(entry).includes('"kind":"camera"'))
    const message = (user?.data as { content: { type: string; attachment?: { attachmentId: string } }[]; source: unknown })
    expect(message.source).toEqual({ kind: 'camera', deviceId: 'front-door', eventId: 'ring-101-900', form: 'notice', summary: 'Front door doorbell press' })
    expect(message.content.filter(block => block.type === 'image').map(block => block.attachment?.attachmentId))
      .toEqual(frames.map(frame => frame.attachment.attachmentId))
    expect(recordOf(harness, 'ring-101-900')?.sessionId).toMatch(/^camera-front-door-/u)
    expect(harness.notices).toEqual([{
      id: 'camera:ring-101-900', channelId: '123456789012345678',
      text: '**Front door** · 12:00: Doorbell rang\nA person in a grey hoodie presses the doorbell.\nSeen: person 1 · confidence 91%',
      image: frames[1]!.attachment,
    }])
    expect(recordOf(harness, 'ring-101-900')).toMatchObject({
      deviceId: 'front-door', kind: 'ding', status: 'parsed', reasons: ['ding'], delivery: 'delivered',
      verdict: { labels: ['person'], activity: 'ringing', confidence: 0.91, personFrames: [1] },
      frames: [{ offsetMs: 0, source: 'snapshot', mediaType: 'image/jpeg' }, { offsetMs: 10_000 }, { offsetMs: 20_000 }],
    })
  })

  it('stays quiet for an ordinary daytime passer-by but records the event', async () => {
    const harness = await start([verdictText({ labels: ['person'], activity: 'passing', personFrames: [0] })])
    mirror(harness)
    await harness.camera.send(harness.event('motion', await harness.frames(2), { id: 'quiet' }))
    await until(() => recordOf(harness, 'quiet') !== undefined, 'history record')
    expect(recordOf(harness, 'quiet')).toMatchObject({ status: 'parsed', reasons: [], delivery: 'none' })
    expect(harness.notices).toEqual([])
  })

  it('notifies a person at night, a delivered package, a lingering visitor, and a garage vehicle', async () => {
    const harness = await start([
      verdictText({ labels: ['person'], personFrames: [0], description: 'Someone walks up the path.' }),
      verdictText({ labels: ['person', 'package'], activity: 'delivering', personFrames: [0] }),
      verdictText({ labels: ['person'], personFrames: [0, 2] }),
      verdictText({ labels: ['vehicle'], counts: { vehicle: 1 } }),
    ], { policy: { vehicleDevices: ['garage'] } })
    mirror(harness)
    await harness.camera.send(harness.event('motion', await harness.frames(1), { id: 'night', at: NIGHT }))
    await until(() => recordOf(harness, 'night')?.delivery === 'delivered', 'night notice')
    await harness.camera.send(harness.event('motion', await harness.frames(2), { id: 'box' }))
    await until(() => recordOf(harness, 'box')?.delivery === 'delivered', 'package notice')
    await harness.camera.send(harness.event('motion', await harness.frames(3, [0, 11_000, 22_000]), { id: 'linger' }))
    await until(() => recordOf(harness, 'linger')?.delivery === 'delivered', 'lingering notice')
    await harness.camera.send(harness.event('motion', await harness.frames(1), { id: 'car', device: 'garage' }))
    await until(() => recordOf(harness, 'car')?.delivery === 'delivered', 'vehicle notice')
    expect(harness.notices.map(notice => notice.text.split('\n')[0])).toEqual([
      '**Front door** · 23:30: Person at night',
      '**Front door** · 12:00: Package delivered',
      '**Front door** · 12:00: Someone lingering (22 s)',
      '**Garage** · 12:00: Vehicle seen',
    ])
  })

  it('uses a configured model route and rejects one without image input', async () => {
    const harness = await start([verdictText({})], { modelSelection: { provider: 'mock', model: 'triage-vision' } })
    mirror(harness)
    await harness.camera.send(harness.event('motion', await harness.frames(1), { id: 'routed' }))
    await until(() => recordOf(harness, 'routed') !== undefined, 'routed record')
    expect(harness.adapter.requests[0]?.model).toBe('triage-vision')
    harness.adapter.inputModalities = ['text']
    await harness.camera.send(harness.event('ding', await harness.frames(1), { id: 'blind' }))
    await until(() => recordOf(harness, 'blind')?.delivery === 'delivered', 'blind ding')
    expect(recordOf(harness, 'blind')).toMatchObject({ status: 'failed', failure: 'MODEL_NOT_VISION', reasons: ['ding'] })
    expect(harness.notices[0]?.text).toContain('The vision check did not answer (MODEL_NOT_VISION).')
    expect(harness.logs.some(log => log.type === 'error' && log.text.includes('declares no image input'))).toBe(true)
    harness.adapter.inputModalities = ['text', 'image']
  })

  it('records an unavailable model route', async () => {
    const harness = await start([], { modelSelection: { provider: 'absent', model: 'x' } })
    mirror(harness)
    await harness.camera.send(harness.event('motion', await harness.frames(1), { id: 'no-route' }))
    await until(() => recordOf(harness, 'no-route') !== undefined, 'failed record')
    expect(recordOf(harness, 'no-route')).toMatchObject({ status: 'failed', failure: 'MODEL_UNAVAILABLE', delivery: 'none' })
    expect(harness.logs.some(log => log.text.startsWith('camera-watch: model route unavailable'))).toBe(true)
  })

  it('reads malformed and partial answers tolerantly', async () => {
    const harness = await start(['I think a person is at the door, maybe.', '{"labels":["person"],"confidence":0.8}'])
    mirror(harness)
    await harness.camera.send(harness.event('ding', await harness.frames(1), { id: 'prose' }))
    await until(() => recordOf(harness, 'prose')?.delivery === 'delivered', 'prose ding')
    expect(recordOf(harness, 'prose')).toMatchObject({ status: 'unparsed', text: 'I think a person is at the door, maybe.' })
    expect(harness.notices[0]?.text.split('\n')[1]).toBe('I think a person is at the door, maybe.')
    await harness.camera.send(harness.event('motion', await harness.frames(1), { id: 'partial', at: NIGHT }))
    await until(() => recordOf(harness, 'partial')?.delivery === 'delivered', 'partial night person')
    expect(recordOf(harness, 'partial')).toMatchObject({ status: 'partial', reasons: ['night-person'] })
  })

  it('records classification turns that fail, time out, or give no answer', async () => {
    const harness = await start([
      [{ type: 'finish', reason: { kind: 'error', failure: { code: 'UPSTREAM', message: 'model crashed' } } }],
      '   ',
      'hang',
    ], { turnTimeoutMs: 300 })
    mirror(harness)
    await harness.camera.send(harness.event('motion', await harness.frames(1), { id: 'crash' }))
    await until(() => recordOf(harness, 'crash') !== undefined, 'crash record')
    await harness.camera.send(harness.event('motion', await harness.frames(1), { id: 'blank' }))
    await until(() => recordOf(harness, 'blank') !== undefined, 'blank record')
    await harness.camera.send(harness.event('motion', await harness.frames(1), { id: 'slow' }))
    await until(() => recordOf(harness, 'slow') !== undefined, 'slow record')
    expect(['crash', 'blank', 'slow'].map(id => recordOf(harness, id)?.failure)).toEqual(['TURN_FAILED', 'NO_ANSWER', 'TIMEOUT'])
  })

  it('denies tool calls through the executor and fails a turn that asks the model again', async () => {
    const harness = await start([toolCallResponse('call-1', 'camera', {}), verdictText({})])
    mirror(harness)
    await harness.camera.send(harness.event('motion', await harness.frames(1), { id: 'tool-use' }))
    await until(() => recordOf(harness, 'tool-use') !== undefined, 'record')
    expect(recordOf(harness, 'tool-use')).toMatchObject({ status: 'failed', failure: 'TURN_FAILED' })
    expect(harness.adapter.requests).toHaveLength(1)
    const result = (await harness.sessionLog()).find(entry => entry.type === 'tool/result')
    expect(result).toMatchObject({ data: { message: { isError: true } } })
  })

  it('runs classifications concurrently up to the bound, each limited to its own request', async () => {
    const harness = await start([verdictText({ description: 'left' }), verdictText({ description: 'right' })], { maxConcurrent: 2 })
    mirror(harness)
    const frames = await harness.frames(1)
    await harness.camera.send(harness.event('motion', frames, { id: 'left' }))
    await harness.camera.send(harness.event('motion', frames, { id: 'right' }))
    await until(() => recordOf(harness, 'left') !== undefined && recordOf(harness, 'right') !== undefined, 'both records')
    expect([recordOf(harness, 'left')?.status, recordOf(harness, 'right')?.status]).toEqual(['parsed', 'parsed'])
  })

  it('records a Session that could not start', async () => {
    const harness = await start([])
    mirror(harness)
    vi.spyOn(harness.ctx.agents, 'create').mockRejectedValueOnce(new Error('factory unavailable'))
    await harness.camera.send(harness.event('motion', await harness.frames(1), { id: 'no-session' }))
    await until(() => recordOf(harness, 'no-session') !== undefined, 'record')
    expect(recordOf(harness, 'no-session')).toMatchObject({ status: 'failed', failure: 'SESSION_FAILED' })
  })

  it('records an answer that could not be persisted', async () => {
    const harness = await start([verdictText({})], {}, { persistence: false })
    mirror(harness)
    await harness.camera.send(harness.event('motion', await harness.frames(1), { id: 'volatile' }))
    await until(() => recordOf(harness, 'volatile') !== undefined, 'record')
    expect(recordOf(harness, 'volatile')?.failure).toBe('NOT_PERSISTED')
  })
})

describe('camera watch admission and delivery', () => {
  it('notifies a doorbell press without frames and skips classification', async () => {
    const harness = await start([])
    mirror(harness)
    await harness.camera.send({ ...harness.event('ding', [], { id: 'dark' }), captureFailure: 'snapshot-unavailable' })
    await until(() => recordOf(harness, 'dark')?.delivery === 'delivered', 'frameless ding')
    expect(harness.adapter.requests).toEqual([])
    expect(recordOf(harness, 'dark')).toMatchObject({ status: 'skipped', failure: 'NO_FRAMES', captureFailure: 'snapshot-unavailable', frames: [] })
    expect(harness.notices[0]).toEqual({ id: 'camera:dark', channelId: '123456789012345678',
      text: '**Front door** · 12:00: Doorbell rang\nNo picture could be captured.\nFewer pictures than planned (snapshot-unavailable).' })
  })

  it('records events beyond the queue bound unclassified and still rings', async () => {
    const harness = await start(['hang', verdictText({})], { maxQueued: 0, turnTimeoutMs: 2_000 })
    mirror(harness)
    await harness.camera.send(harness.event('motion', await harness.frames(1), { id: 'busy' }))
    await until(() => harness.adapter.requests.length === 1, 'first classification')
    await harness.camera.send(harness.event('ding', await harness.frames(1), { id: 'overflow' }))
    await until(() => recordOf(harness, 'overflow')?.delivery === 'delivered', 'overflow ding')
    expect(recordOf(harness, 'overflow')).toMatchObject({ status: 'skipped', failure: 'QUEUE_FULL' })
    expect(harness.notices[0]?.text).toContain('Not checked: earlier events were still being checked.')
  })

  it('queues events up to the bound and classifies them in order', async () => {
    const harness = await start([verdictText({ description: 'first' }), verdictText({ description: 'second' })])
    mirror(harness)
    const frames = await harness.frames(1)
    await harness.camera.send(harness.event('motion', frames, { id: 'one' }))
    await harness.camera.send(harness.event('motion', frames, { id: 'two' }))
    await until(() => recordOf(harness, 'two') !== undefined, 'second record')
    expect([recordOf(harness, 'one')?.verdict?.description, recordOf(harness, 'two')?.verdict?.description]).toEqual(['first', 'second'])
  })

  it('ignores repeated event ids and unknown devices', async () => {
    const harness = await start([verdictText({})])
    mirror(harness)
    const event = harness.event('motion', await harness.frames(1), { id: 'repeat' })
    await harness.camera.send(event)
    await harness.camera.send(event)
    await until(() => recordOf(harness, 'repeat') !== undefined, 'record')
    await harness.camera.send(event)
    await harness.camera.send(harness.event('motion', [], { id: 'stray', device: 'porch' }))
    expect(harness.adapter.requests).toHaveLength(1)
    expect(harness.logs.some(log => log.text === 'camera-watch: event stray names unknown device "porch"')).toBe(true)
  })

  it('retries a refused or failed handoff and records an undelivered notice', async () => {
    const sleeps: number[] = []
    const harness = await start([], { deliveryAttempts: 3, deliveryRetryMs: 5_000 }, { deps: { sleep: async (ms) => { sleeps.push(ms) } } })
    mirror(harness)
    harness.noticeReplies.push('refuse', 'throw', 'refuse')
    await harness.camera.send(harness.event('ding', [], { id: 'lost' }))
    await until(() => harness.notices.length === 3 && recordOf(harness, 'lost') !== undefined, 'three attempts')
    await until(() => harness.logs.filter(log => log.text.includes('camera:lost')).length === 3, 'attempt logs')
    expect(recordOf(harness, 'lost')?.delivery).toBe('undelivered')
    expect(sleeps).toEqual([5_000, 5_000])
    expect(harness.logs.filter(log => log.text.includes('camera:lost')).map(log => log.text)).toEqual([
      'camera-watch: no delivery owner accepted camera:lost (attempt 1)',
      'camera-watch: delivery of camera:lost failed (attempt 2): outbox full',
      'camera-watch: no delivery owner accepted camera:lost (attempt 3)',
    ])
  })

  it('keeps history only when no channel is configured, and can omit the tool', async () => {
    const harness = await start([], { tool: false }, { noticeListener: false, channel: false })
    mirror(harness)
    await harness.camera.send(harness.event('ding', [], { id: 'local' }))
    await until(() => recordOf(harness, 'local') !== undefined, 'record')
    expect(recordOf(harness, 'local')).toMatchObject({ reasons: ['ding'], delivery: 'no-channel' })
    expect(harness.ctx.tools.schemas().map(schema => schema.name)).not.toContain('camera')
  })

  it('refuses a vehicle rule naming an unknown device', async () => {
    await expect(watchHarness([], { policy: { vehicleDevices: ['driveway'] } }, {
      load: async (load) => { await expect(load).rejects.toThrow('policy.vehicleDevices names unknown camera device "driveway"') },
    }).then(async (harness) => { await harness.dispose() })).resolves.toBeUndefined()
  })

  it('stops classification and delivery waits on disposal and still records the event', async () => {
    const harness = await watchHarness(['hang'], { turnTimeoutMs: 60_000, deliveryRetryMs: 60_000 }, { noticeListener: false })
    mirror(harness)
    await harness.camera.send(harness.event('ding', await harness.frames(1), { id: 'shutdown' }))
    await until(() => harness.adapter.requests.length === 1, 'classification start')
    await harness.fiber.dispose()
    const stored = JSON.parse(await readFile(join(harness.root, 'storage', 'camera_watch.json'), 'utf8')) as { tables: { events: Record<string, unknown> } }
    await harness.dispose()
    expect(stored.tables.events['shutdown']).toMatchObject({ status: 'failed', failure: 'TIMEOUT', reasons: ['ding'], delivery: 'undelivered' })
  })

  it('stops a delivery retry wait on disposal', async () => {
    const harness = await watchHarness([], { deliveryRetryMs: 60_000 }, { noticeListener: false })
    await harness.camera.send(harness.event('ding', [], { id: 'waiting' }))
    await until(() => harness.logs.some(log => log.text.includes('no delivery owner accepted camera:waiting')), 'first attempt')
    await harness.dispose()
    await harness.camera.send(harness.event('ding', [], { id: 'after' }))
  })
})

describe('camera watch history retention', () => {
  it('prunes by age and count on each sweep', async () => {
    const harness = await start([], { retentionDays: 1, maxHistory: 2, sweepIntervalMs: 20 }, { deps: { now: () => NOON } })
    mirror(harness)
    for (const [id, age] of [['old', 3 * 86_400_000], ['a', 3_000], ['b', 2_000], ['c', 1_000]] as const) {
      await harness.camera.send(harness.event('motion', [], { id, at: NOON - age }))
      await until(() => written.get(harness)?.has(id) === true, `record ${id}`)
    }
    await until(() => records.get(harness)?.size === 2, 'sweep')
    expect([...records.get(harness)?.keys() ?? []].sort()).toEqual(['b', 'c'])
  })

  it('logs a failed sweep and keeps sweeping', async () => {
    const harness = await start([], { sweepIntervalMs: 20 }, { deps: { now: () => { throw new Error('clock unavailable') } } })
    await until(() => harness.logs.filter(log => log.text.startsWith('camera-watch: history sweep failed')).length >= 2, 'two failed sweeps')
  })
})
