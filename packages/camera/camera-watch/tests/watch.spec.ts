import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import type { CameraFrame } from '@deepseek-ai/dsh-camera'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { defineTool, TEXT_TOOL_OUTPUT } from '@deepseek-ai/dsh-tools'
import { toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { cameraWatchDomainSpec, historyRecord } from '../src/history.ts'
import { CLASSIFICATION_SYSTEM_PROMPT } from '../src/verdict.ts'
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

  it('stays quiet for an ordinary daytime passer-by and for parked cars on a vehicle camera but records the events', async () => {
    const harness = await start([
      verdictText({ labels: ['person'], activity: 'passing', personFrames: [0] }),
      verdictText({ labels: ['vehicle'], counts: { vehicle: 3 }, vehicleActivity: 'parked', description: 'Three parked vehicles, one idling with headlights on.' }),
    ], { policy: { vehicleDevices: ['garage'] } })
    mirror(harness)
    await harness.camera.send(harness.event('motion', await harness.frames(2), { id: 'quiet' }))
    await until(() => recordOf(harness, 'quiet') !== undefined, 'history record')
    expect(recordOf(harness, 'quiet')).toMatchObject({ status: 'parsed', reasons: [], delivery: 'none' })
    await harness.camera.send(harness.event('motion', await harness.frames(1), { id: 'parked', device: 'garage' }))
    await until(() => recordOf(harness, 'parked') !== undefined, 'parked record')
    expect(recordOf(harness, 'parked')).toMatchObject({ status: 'parsed', reasons: [], delivery: 'none',
      verdict: { labels: ['vehicle'], vehicleActivity: 'parked' } })
    expect(harness.notices).toEqual([])
  })

  it('notifies a person at night, a delivered package, a lingering visitor, and a garage vehicle', async () => {
    const harness = await start([
      verdictText({ labels: ['person'], personFrames: [0], description: 'Someone walks up the path.' }),
      verdictText({ labels: ['person', 'package'], activity: 'delivering', personFrames: [0] }),
      verdictText({ labels: ['person'], personFrames: [0, 2] }),
      verdictText({ labels: ['vehicle'], counts: { vehicle: 2 }, vehicleActivity: 'arriving' }),
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
      '**Garage** · 12:00: Vehicle arriving',
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
    expect(harness.notices.find(notice => notice.id === 'camera:blind')?.text).toContain('The vision check did not answer (MODEL_NOT_VISION).')
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

  it('sends only the classification system prompt and no tools, even tools registered into the Agent scope', async () => {
    const harness = await start([verdictText({})])
    mirror(harness)
    harness.ctx.systemPrompt.section({ name: 'test:host-persona', order: 5, text: 'You are a coding agent.' })
    harness.ctx.systemPrompt.context({ name: 'test:runtime', order: 1, text: 'Current runtime fact.' })
    harness.ctx.on('agent/created', ({ agent }) => {
      agent.ctx.effect(() => agent.ctx.tools.register(defineTool({
        name: 'schedule_create', description: 'Create a reminder.', parameters: {}, output: TEXT_TOOL_OUTPUT,
        execute: () => Promise.resolve({ text: 'created' }),
      })))
    })
    await harness.camera.send(harness.event('motion', await harness.frames(1), { id: 'bare' }))
    await until(() => recordOf(harness, 'bare') !== undefined, 'record')
    const [request] = harness.adapter.requests
    expect(request?.tools ?? []).toEqual([])
    const text = request!.messages.map(message => message.content.map(block => block.type === 'text' ? block.text : '').join('')).join('\n')
    expect(request!.messages.filter(message => message.role === 'system').map(message => message.content))
      .toEqual([[{ type: 'text', text: CLASSIFICATION_SYSTEM_PROMPT }]])
    expect(text).not.toContain('You are a coding agent.')
    expect(text).not.toContain('Current runtime fact.')
    const log = await harness.sessionLog()
    expect(log.find(entry => entry.type === 'system/message')).toMatchObject({ data: { message: { content: [{ type: 'text', text: CLASSIFICATION_SYSTEM_PROMPT }] } } })
    expect(log.find(entry => entry.type === 'request/header')).toMatchObject({ data: { header: { config: { model: 'vision-model' } } } })
    expect((log.find(entry => entry.type === 'request/header')?.data as { header: { tools?: unknown } }).header.tools).toBeUndefined()
  })

  it('denies tool calls, including Agent-scope tools, and fails a turn that asks the model again', async () => {
    const harness = await start([toolCallResponse('call-1', 'schedule_create', {}), verdictText({})])
    mirror(harness)
    const executed: string[] = []
    harness.ctx.on('agent/created', ({ agent }) => {
      agent.ctx.effect(() => agent.ctx.tools.register(defineTool({
        name: 'schedule_create', description: 'Create a reminder.', parameters: {}, output: TEXT_TOOL_OUTPUT,
        execute: () => { executed.push('schedule_create'); return Promise.resolve({ text: 'created' }) },
      })))
    })
    await harness.camera.send(harness.event('motion', await harness.frames(1), { id: 'tool-use' }))
    await until(() => recordOf(harness, 'tool-use') !== undefined, 'record')
    expect(recordOf(harness, 'tool-use')).toMatchObject({ status: 'failed', failure: 'TURN_FAILED' })
    expect(harness.adapter.requests).toHaveLength(1)
    expect(executed).toEqual([])
    const result = (await harness.sessionLog()).find(entry => entry.type === 'tool/result')
    expect(result).toMatchObject({ data: { message: { isError: true } } })
    expect(JSON.stringify(result)).toContain('camera classification runs without tools')
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

  it('refuses a person rule naming an unknown device', async () => {
    await expect(watchHarness([], { policy: { personDevices: ['porch'] } }, {
      load: async (load) => { await expect(load).rejects.toThrow('policy.personDevices names unknown camera device "porch"') },
    }).then(async (harness) => { await harness.dispose() })).resolves.toBeUndefined()
  })

  it('notifies a daytime passer-by on a person device and stays quiet for the same verdict on the garage', async () => {
    const passerBy = verdictText({ labels: ['person'], activity: 'passing', personFrames: [0], description: 'A neighbour walks past.' })
    const harness = await start([passerBy, passerBy], { policy: { personDevices: ['front-door'] } })
    mirror(harness)
    await harness.camera.send(harness.event('motion', await harness.frames(1), { id: 'visitor' }))
    await until(() => recordOf(harness, 'visitor')?.delivery === 'delivered', 'person notice')
    await harness.camera.send(harness.event('motion', await harness.frames(1), { id: 'garage-walker', device: 'garage' }))
    await until(() => recordOf(harness, 'garage-walker') !== undefined, 'garage record')
    expect(recordOf(harness, 'visitor')).toMatchObject({ reasons: ['person'] })
    expect(recordOf(harness, 'garage-walker')).toMatchObject({ reasons: [], delivery: 'none' })
    expect(harness.notices.map(notice => notice.text.split('\n')[0])).toEqual(['**Front door** · 12:00: Person at Front door'])
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

  it('posts a doorbell notice with the first frame at once, then the classified notice with a better frame as a follow-up', async () => {
    const harness = await start([verdictText({ labels: ['person'], counts: { person: 1 }, activity: 'ringing', confidence: 0.9,
      description: 'A courier waits at the door.', personFrames: [1, 2] })])
    mirror(harness)
    const frames = await harness.frames(3)
    const event = harness.event('ding', frames, { id: 'rang' })
    await harness.camera.preview(event)
    expect(harness.notices).toEqual([{ id: 'camera:rang:ding', channelId: '123456789012345678',
      text: '**Front door** · 12:00: Someone rang the doorbell', image: frames[0]!.attachment }])
    await harness.camera.send(event)
    await until(() => recordOf(harness, 'rang')?.delivery === 'delivered', 'follow-up')
    expect(harness.notices.map(notice => [notice.id, notice.text.split('\n')[1], notice.image?.attachmentId])).toEqual([
      ['camera:rang:ding', undefined, frames[0]!.attachment.attachmentId],
      ['camera:rang', 'A courier waits at the door.', frames[1]!.attachment.attachmentId],
    ])
    expect(recordOf(harness, 'rang')).toMatchObject({ reasons: ['ding'], earlyDelivery: 'delivered', delivery: 'delivered' })
  })

  it('does not attach the shown frame again and states a failed check in the follow-up', async () => {
    const harness = await start([[{ type: 'finish', reason: { kind: 'error', failure: { code: 'UPSTREAM', message: 'down' } } }]])
    mirror(harness)
    const event = harness.event('ding', await harness.frames(2), { id: 'unchecked' })
    await harness.camera.preview(event)
    await harness.camera.send(event)
    await until(() => recordOf(harness, 'unchecked')?.delivery === 'delivered', 'follow-up')
    expect(harness.notices[1]).toEqual({ id: 'camera:unchecked', channelId: '123456789012345678',
      text: '**Front door** · 12:00: Doorbell rang\nThe vision check did not answer (TURN_FAILED).' })
    expect(recordOf(harness, 'unchecked')).toMatchObject({ status: 'failed', earlyDelivery: 'delivered', delivery: 'delivered' })
  })

  it('records a refused immediate notice and attaches the frame to the follow-up', async () => {
    const sleeps: number[] = []
    const harness = await start([verdictText({})], { deliveryAttempts: 1 }, { deps: { sleep: async (ms) => { sleeps.push(ms) } } })
    mirror(harness)
    harness.noticeReplies.push('refuse')
    const event = harness.event('ding', await harness.frames(1), { id: 'refused' })
    await harness.camera.preview(event)
    await harness.camera.send(event)
    await until(() => recordOf(harness, 'refused')?.delivery === 'delivered', 'follow-up')
    expect(recordOf(harness, 'refused')).toMatchObject({ earlyDelivery: 'undelivered', delivery: 'delivered' })
    expect(harness.notices[1]?.image).toEqual(event.frames[0]!.attachment)
  })

  it('ignores doorbell previews of repeated or recorded events, of unknown devices, and when disabled or without a channel', async () => {
    const harness = await start([verdictText({}), verdictText({})])
    mirror(harness)
    const frames = await harness.frames(1)
    await harness.camera.preview(harness.event('ding', frames, { id: 'stray', device: 'porch' }))
    const twice = harness.event('ding', frames, { id: 'twice' })
    await harness.camera.preview(twice)
    await harness.camera.preview(twice)
    await harness.camera.send(twice)
    await until(() => recordOf(harness, 'twice')?.delivery === 'delivered', 'twice record')
    await harness.camera.preview(twice)
    const queued = harness.event('ding', frames, { id: 'queued' })
    await harness.camera.send(queued)
    await harness.camera.preview(queued)
    await until(() => recordOf(harness, 'queued')?.delivery === 'delivered', 'queued record')
    expect(harness.notices.map(notice => notice.id)).toEqual(['camera:twice:ding', 'camera:twice', 'camera:queued'])
    const disabled = [[{ immediateDingNotice: false }, {}], [{ policy: { ding: false } }, {}], [{}, { channel: false as const }]] as const
    for (const [config, options] of disabled) {
      const quiet = await start([], config, options)
      await quiet.camera.preview(quiet.event('ding', frames, { id: 'off' }))
      expect(quiet.notices).toEqual([])
    }
  })

  it('keeps a previewed frame through a sweep until its event is recorded', async () => {
    const harness = await start([verdictText({})], { retentionDays: 1, sweepIntervalMs: 20 }, { deps: { now: () => NOON } })
    mirror(harness)
    const [frame] = await harness.frames(1)
    await harness.camera.preview(harness.event('ding', [frame!], { id: 'pending' }))
    await harness.camera.send(harness.event('motion', [frame!], { id: 'expired', at: NOON - 3 * 86_400_000 }))
    await until(() => written.get(harness)?.has('expired') === true && recordOf(harness, 'expired') === undefined, 'expired record pruned')
    expect((await harness.ctx.attachments.readImage(frame!.attachment)).data.length).toBeGreaterThan(0)
  })

  it('stops a delivery retry wait on disposal', async () => {
    const harness = await watchHarness([], { deliveryRetryMs: 60_000 }, { noticeListener: false })
    await harness.camera.send(harness.event('ding', [], { id: 'waiting' }))
    await until(() => harness.logs.some(log => log.text.includes('no delivery owner accepted camera:waiting')), 'first attempt')
    await harness.dispose()
    await harness.camera.send(harness.event('ding', [], { id: 'after' }))
  })
})

describe('camera watch early motion notice', () => {
  const doorPerson = (fields: Record<string, unknown> = {}): string => verdictText({ labels: ['person'], counts: { person: 1 }, activity: 'passing',
    description: 'A person walks up the path.', personFrames: [0], ...fields })

  it('posts a notice from the first frame at once and no update when the full check adds nothing, logging both Sessions', async () => {
    const harness = await start([doorPerson(), doorPerson({ description: 'Someone in a cap walks to the door.' })],
      { policy: { personDevices: ['front-door'] } })
    mirror(harness)
    const frames = await harness.frames(3, [300, 10_000, 20_000])
    const event = harness.event('motion', frames, { id: 'walk-up' })
    await harness.camera.preview(event)
    await until(() => harness.notices.length === 1, 'early notice')
    expect(harness.notices[0]).toEqual({ id: 'camera:walk-up:early', channelId: '123456789012345678',
      text: '**Front door** · 12:00: Person at Front door\nA person walks up the path.\nSeen: person 1 · confidence 90%\n'
        + 'From the first picture; an update follows only if the rest shows more.',
      image: frames[0]!.attachment })
    expect(userText(harness.adapter.requests[0]!)).toContain('The image is only the first frame, taken 0 s after the alert;')
    expect(userText(harness.adapter.requests[0]!).endsWith('|[image]')).toBe(true)
    await harness.camera.send(event)
    await until(() => recordOf(harness, 'walk-up') !== undefined, 'record')
    const record = recordOf(harness, 'walk-up')!
    expect(record).toMatchObject({ status: 'parsed', reasons: ['person'], delivery: 'none', earlyDelivery: 'delivered', earlyReasons: ['person'] })
    expect(record.earlySessionId).toMatch(/^camera-front-door-/u)
    expect(record.earlySessionId).not.toBe(record.sessionId)
    expect(harness.notices).toHaveLength(1)
    const log = await harness.sessionLog()
    const sources = log.filter(entry => entry.type === 'user/message').map(entry => (entry.data as { source: { summary: string } }).source.summary)
    expect(sources.sort()).toEqual(['Front door motion', 'Front door motion (first frame)'])
  })

  it('posts an update when the full check adds a reason or counts more, without attaching the frame already shown', async () => {
    const harness = await start([
      doorPerson(), doorPerson({ personFrames: [0, 2] }),
      doorPerson(), doorPerson({ counts: { person: 2 }, description: 'Two people wait at the door.', personFrames: [1] }),
    ], { policy: { personDevices: ['front-door'] } })
    mirror(harness)
    const lingering = harness.event('motion', await harness.frames(3, [0, 11_000, 22_000]), { id: 'stays' })
    await harness.camera.preview(lingering)
    await harness.camera.send(lingering)
    await until(() => recordOf(harness, 'stays')?.delivery === 'delivered', 'lingering update')
    const frames = await harness.frames(2)
    const pair = harness.event('motion', frames, { id: 'pair' })
    await harness.camera.preview(pair)
    await harness.camera.send(pair)
    await until(() => recordOf(harness, 'pair')?.delivery === 'delivered', 'count update')
    expect(harness.notices.map(notice => [notice.id, notice.text.split('\n')[0], notice.image?.attachmentId])).toEqual([
      ['camera:stays:early', '**Front door** · 12:00: Person at Front door', lingering.frames[0]!.attachment.attachmentId],
      ['camera:stays', '**Front door** · 12:00 (update): Person at Front door; Someone lingering (22 s)', undefined],
      ['camera:pair:early', '**Front door** · 12:00: Person at Front door', frames[0]!.attachment.attachmentId],
      ['camera:pair', '**Front door** · 12:00 (update): Person at Front door', frames[1]!.attachment.attachmentId],
    ])
    expect(recordOf(harness, 'stays')).toMatchObject({ reasons: ['person', 'lingering'], earlyReasons: ['person'], earlyDelivery: 'delivered' })
  })

  it('posts only the full notice when the first frame does not notify, its check fails, or its notice is refused', async () => {
    const harness = await start([
      verdictText({ description: 'An empty path.' }), doorPerson(),
      [{ type: 'finish', reason: { kind: 'error', failure: { code: 'UPSTREAM', message: 'down' } } }], doorPerson(),
      doorPerson(), doorPerson(),
    ], { policy: { personDevices: ['front-door'] }, deliveryAttempts: 1 })
    mirror(harness)
    const empty = harness.event('motion', await harness.frames(2), { id: 'empty-first' })
    await harness.camera.preview(empty)
    await harness.camera.send(empty)
    await until(() => recordOf(harness, 'empty-first')?.delivery === 'delivered', 'full notice')
    const failed = harness.event('motion', await harness.frames(2), { id: 'failed-first' })
    await harness.camera.preview(failed)
    await harness.camera.send(failed)
    await until(() => recordOf(harness, 'failed-first')?.delivery === 'delivered', 'full notice after failure')
    const refused = harness.event('motion', await harness.frames(2), { id: 'refused-first' })
    harness.noticeReplies.push('refuse')
    await harness.camera.preview(refused)
    await harness.camera.send(refused)
    await until(() => recordOf(harness, 'refused-first')?.delivery === 'delivered', 'full notice after refusal')
    expect(harness.notices.map(notice => [notice.id, notice.text.split('\n')[0], notice.image?.attachmentId])).toEqual([
      ['camera:empty-first', '**Front door** · 12:00: Person at Front door', empty.frames[0]!.attachment.attachmentId],
      ['camera:failed-first', '**Front door** · 12:00: Person at Front door', failed.frames[0]!.attachment.attachmentId],
      ['camera:refused-first:early', '**Front door** · 12:00: Person at Front door', refused.frames[0]!.attachment.attachmentId],
      ['camera:refused-first', '**Front door** · 12:00: Person at Front door', refused.frames[0]!.attachment.attachmentId],
    ])
    expect(recordOf(harness, 'empty-first')).toMatchObject({ earlyReasons: [], delivery: 'delivered' })
    expect(recordOf(harness, 'empty-first')).not.toHaveProperty('earlyDelivery')
    expect(recordOf(harness, 'failed-first')?.earlySessionId).toMatch(/^camera-front-door-/u)
    expect(recordOf(harness, 'failed-first')).not.toHaveProperty('earlyReasons')
    expect(recordOf(harness, 'refused-first')).toMatchObject({ earlyReasons: ['person'], earlyDelivery: 'undelivered', delivery: 'delivered' })
  })

  it('runs a queued first-frame check before queued events once a slot frees', async () => {
    const harness = await start(['hang', doorPerson(), verdictText({ description: 'later' }), doorPerson()],
      { policy: { personDevices: ['front-door'] }, turnTimeoutMs: 1_000 })
    mirror(harness)
    await harness.camera.send(harness.event('motion', await harness.frames(1), { id: 'slow' }))
    await until(() => harness.adapter.requests.length === 1, 'first classification')
    await harness.camera.send(harness.event('motion', await harness.frames(1), { id: 'waiting' }))
    const jump = harness.event('motion', await harness.frames(1), { id: 'jump' })
    await harness.camera.preview(jump)
    expect(harness.adapter.requests).toHaveLength(1)
    await until(() => harness.notices.some(notice => notice.id === 'camera:jump:early'), 'early notice')
    expect(userText(harness.adapter.requests[1]!)).toContain('only the first frame')
    await harness.camera.send(jump)
    await until(() => recordOf(harness, 'jump') !== undefined && recordOf(harness, 'waiting') !== undefined, 'records')
    expect(recordOf(harness, 'waiting')?.verdict?.description).toBe('later')
  })

  it('skips the first-frame check when disabled, without a channel, or when the event queue is full, and drops a queued one at disposal', async () => {
    const frames = await (await start([])).frames(1)
    for (const [config, options] of [[{ earlyMotionNotice: false }, {}], [{}, { channel: false as const }]] as const) {
      const quiet = await start([], config, options)
      await quiet.camera.preview(quiet.event('motion', frames, { id: 'off' }))
      expect(quiet.adapter.requests).toEqual([])
    }
    const full = await start(['hang'], { maxQueued: 0, turnTimeoutMs: 60_000 })
    await full.camera.send(full.event('motion', frames, { id: 'busy' }))
    await until(() => full.adapter.requests.length === 1, 'busy classification')
    await full.camera.preview(full.event('motion', frames, { id: 'crowded' }))
    const queued = await start(['hang'], { turnTimeoutMs: 60_000 })
    await queued.camera.send(queued.event('motion', frames, { id: 'busy' }))
    await until(() => queued.adapter.requests.length === 1, 'busy classification')
    await queued.camera.preview(queued.event('motion', frames, { id: 'pending' }))
    await full.dispose()
    await queued.dispose()
    expect([full.adapter.requests.length, queued.adapter.requests.length]).toEqual([1, 1])
  })
})

describe('camera watch arrival detection', () => {
  const HOUR = 3_600_000
  const cars = (vehicle: number, fields: Record<string, unknown> = {}): string => verdictText({ labels: vehicle === 0 ? [] : ['vehicle'],
    counts: { vehicle }, vehicleActivity: vehicle === 0 ? 'none' : 'parked', description: `${String(vehicle)} vehicles stand in the driveway.`, ...fields })

  it('reads a higher vehicle count than the previous garage event as arriving and a lower one as leaving', async () => {
    const harness = await start([cars(2), cars(3), cars(3, { confidence: 0.3 }), cars(1), cars(1)],
      { earlyMotionNotice: false, policy: { vehicleDevices: ['garage'] } })
    mirror(harness)
    const send = async (id: string, at: number, device = 'garage'): Promise<void> => {
      await harness.camera.send(harness.event('motion', await harness.frames(1), { id, at, device }))
      await until(() => recordOf(harness, id) !== undefined && recordOf(harness, id)?.delivery !== 'undelivered', id)
    }
    await send('evening', NOON - 2 * HOUR)
    await send('arrival', NOON)
    await send('doubtful', NOON + 60_000)
    await send('departure', NOON + 2 * 60_000)
    await send('front', NOON + 3 * 60_000, 'front-door')
    expect(recordOf(harness, 'evening')).toMatchObject({ reasons: [], delivery: 'none' })
    expect(recordOf(harness, 'evening')).not.toHaveProperty('vehicleChange')
    expect(recordOf(harness, 'arrival')).toMatchObject({ reasons: ['vehicle'], vehicleChange: 'arriving', baselineEventId: 'evening',
      verdict: { vehicleActivity: 'parked', counts: { vehicle: 3 } } })
    expect(recordOf(harness, 'doubtful')).toMatchObject({ reasons: [] })
    expect(recordOf(harness, 'doubtful')).not.toHaveProperty('vehicleChange')
    expect(recordOf(harness, 'departure')).toMatchObject({ reasons: ['vehicle'], vehicleChange: 'leaving', baselineEventId: 'arrival' })
    expect(recordOf(harness, 'front')).not.toHaveProperty('vehicleChange')
    expect(harness.notices.map(notice => notice.text)).toEqual([
      '**Garage** · 12:00: Vehicle arriving\n3 vehicles stand in the driveway.\nSeen: vehicle 3 · confidence 90%',
      '**Garage** · 12:02: Vehicle leaving\n1 vehicles stand in the driveway.\nSeen: vehicle 1 · confidence 90%',
    ])
  })

  it('compares nothing when the window is off or the previous event is older than the window', async () => {
    for (const [policy, gap] of [[{ arrivalBaselineMs: 0 }, HOUR], [{ arrivalBaselineMs: HOUR }, HOUR + 1]] as const) {
      const harness = await start([cars(2), cars(3)], { earlyMotionNotice: false, policy: { vehicleDevices: ['garage'], ...policy } })
      mirror(harness)
      await harness.camera.send(harness.event('motion', await harness.frames(1), { id: 'before', at: NOON - gap, device: 'garage' }))
      await until(() => recordOf(harness, 'before') !== undefined, 'before')
      await harness.camera.send(harness.event('motion', await harness.frames(1), { id: 'after', at: NOON, device: 'garage' }))
      await until(() => recordOf(harness, 'after') !== undefined, 'after')
      expect(recordOf(harness, 'after')).toMatchObject({ reasons: [], delivery: 'none' })
      expect(recordOf(harness, 'after')).not.toHaveProperty('vehicleChange')
    }
  })
})

describe('camera watch history retention', () => {
  const DAY = 86_400_000

  function sweepLogs(harness: WatchHarness): string[] {
    return harness.logs.filter(log => log.text.startsWith('camera-watch: retention')).map(log => `${log.type}: ${log.text}`)
  }

  async function readable(harness: WatchHarness, frame: CameraFrame): Promise<boolean | string> {
    try {
      await harness.ctx.attachments.readImage(frame.attachment)
      return true
    } catch (error: unknown) {
      return (error as { code?: string }).code ?? String(error)
    }
  }

  it('prunes by age and count on each sweep', async () => {
    const harness = await start([], { retentionDays: 1, maxHistory: 2, sweepIntervalMs: 20 }, { deps: { now: () => NOON } })
    mirror(harness)
    for (const [id, age] of [['old', 3 * DAY], ['a', 3_000], ['b', 2_000], ['c', 1_000]] as const) {
      await harness.camera.send(harness.event('motion', [], { id, at: NOON - age }))
      await until(() => written.get(harness)?.has(id) === true, `record ${id}`)
    }
    await until(() => records.get(harness)?.size === 2, 'sweep')
    expect([...records.get(harness)?.keys() ?? []].sort()).toEqual(['b', 'c'])
  })

  it('deletes an expired event with the frames no kept event cites and leaves its classification Session in the log', async () => {
    let clock = NOON
    const harness = await start([verdictText({}), verdictText({})], { retentionDays: 1, sweepIntervalMs: 20 },
      { deps: { now: () => clock } })
    mirror(harness)
    const [shared, edgeOnly] = await harness.frames(2, undefined, [20, 60])
    const [oldOnly] = await harness.frames(1, undefined, [100])
    await harness.camera.send(harness.event('motion', [shared!, edgeOnly!], { id: 'edge', at: NOON - DAY }))
    await until(() => recordOf(harness, 'edge')?.status === 'parsed', 'edge record')
    await harness.camera.send(harness.event('motion', [oldOnly!, shared!], { id: 'old', at: NOON - DAY - 1 }))
    await until(() => written.get(harness)?.has('old') === true && recordOf(harness, 'old') === undefined, 'old event pruned')
    expect(recordOf(harness, 'edge')).toBeDefined()
    expect(await Promise.all([oldOnly!, shared!, edgeOnly!].map(frame => readable(harness, frame))))
      .toEqual(['ATTACHMENT_NOT_FOUND', true, true])
    await until(() => sweepLogs(harness).length === 1, 'retention log')
    expect(sweepLogs(harness)).toEqual(['info: camera-watch: retention removed 1 events and 1 frames'])

    clock += 1
    await until(() => records.get(harness)?.size === 0, 'edge event pruned')
    expect(await Promise.all([shared!, edgeOnly!].map(frame => readable(harness, frame)))).toEqual(['ATTACHMENT_NOT_FOUND', 'ATTACHMENT_NOT_FOUND'])
    await until(() => sweepLogs(harness).length === 2, 'second retention log')
    expect(sweepLogs(harness)[1]).toBe('info: camera-watch: retention removed 1 events and 2 frames')
    const sessions = (await harness.sessionLog()).filter(entry => entry.type === 'user/message' && JSON.stringify(entry).includes('"kind":"camera"'))
    expect(sessions).toHaveLength(2)
  })

  it('keeps frames an unfinished event cites', async () => {
    let clock = NOON - 2 * DAY
    const harness = await start([verdictText({}), 'hang'], { retentionDays: 1, sweepIntervalMs: 20, turnTimeoutMs: 60_000 }, { deps: { now: () => clock } })
    mirror(harness)
    const [frame] = await harness.frames(1)
    await harness.camera.send(harness.event('motion', [frame!], { id: 'old', at: NOON - 2 * DAY }))
    await until(() => recordOf(harness, 'old')?.status === 'parsed', 'old record')
    await harness.camera.send(harness.event('motion', [frame!], { id: 'waiting', at: NOON }))
    await until(() => harness.adapter.requests.length === 2, 'second classification start')
    clock = NOON
    await until(() => recordOf(harness, 'old') === undefined, 'old event pruned')
    expect(await readable(harness, frame!)).toBe(true)
    expect(sweepLogs(harness)).toEqual(['info: camera-watch: retention removed 1 events and 0 frames'])
  })

  it('keeps an event whose frame could not be deleted and removes it on a later sweep', async () => {
    const harness = await start([verdictText({})], { retentionDays: 1, sweepIntervalMs: 20 }, { deps: { now: () => NOON } })
    mirror(harness)
    const frames = await harness.frames(2)
    const deleteImage = vi.spyOn(LocalAttachmentStore.prototype, 'deleteImage')
    try {
      deleteImage.mockRejectedValueOnce(new Error('disk offline'))
      await harness.camera.send(harness.event('motion', frames, { id: 'stuck', at: NOON - 2 * DAY }))
      await until(() => written.get(harness)?.has('stuck') === true && recordOf(harness, 'stuck') === undefined, 'stuck event pruned')
    } finally {
      deleteImage.mockRestore()
    }
    expect(sweepLogs(harness)).toEqual([
      'info: camera-watch: retention removed 0 events and 1 frames',
      'warn: camera-watch: retention kept events with 1 undeletable frames: disk offline',
      'info: camera-watch: retention removed 1 events and 1 frames',
    ])
    expect(await Promise.all(frames.map(frame => readable(harness, frame)))).toEqual(['ATTACHMENT_NOT_FOUND', 'ATTACHMENT_NOT_FOUND'])
  })

  it('removes an event whose frames are already gone without counting them', async () => {
    const harness = await start([verdictText({})], { retentionDays: 1, sweepIntervalMs: 60_000 }, { deps: { now: () => NOON } })
    mirror(harness)
    const frames = await harness.frames(1)
    await harness.camera.send(harness.event('motion', frames, { id: 'gone', at: NOON - 2 * DAY }))
    await until(() => recordOf(harness, 'gone')?.status === 'parsed', 'record')
    await harness.ctx.attachments.deleteImage(frames[0]!.attachment)
    await harness.fiber.dispose()
    harness.remount()
    await until(() => recordOf(harness, 'gone') === undefined, 'startup sweep')
    expect(sweepLogs(harness)).toEqual(['info: camera-watch: retention removed 1 events and 0 frames'])
  })

  it('catches up at startup on events that expired while the watch was stopped', async () => {
    let clock = NOON
    const harness = await start([verdictText({}), verdictText({})], { retentionDays: 1, sweepIntervalMs: 3_600_000 },
      { deps: { now: () => clock } })
    mirror(harness)
    const frames = await harness.frames(2, undefined, [20, 60])
    await harness.camera.send(harness.event('motion', [frames[0]!], { id: 'first' }))
    await until(() => recordOf(harness, 'first')?.status === 'parsed', 'first record')
    await harness.camera.send(harness.event('ding', [frames[1]!], { id: 'second', at: NOON + 1_000 }))
    await until(() => recordOf(harness, 'second')?.delivery === 'delivered', 'second record')
    await harness.fiber.dispose()
    clock = NOON + 30 * DAY
    harness.remount()
    await until(() => records.get(harness)?.size === 0, 'startup sweep')
    expect(await Promise.all(frames.map(frame => readable(harness, frame)))).toEqual(['ATTACHMENT_NOT_FOUND', 'ATTACHMENT_NOT_FOUND'])
    expect(sweepLogs(harness)).toEqual(['info: camera-watch: retention removed 2 events and 2 frames'])
  })

  it('stops a sweep at disposal and schedules no further sweep', async () => {
    const harness = await start([verdictText({}), verdictText({})], { retentionDays: 1, sweepIntervalMs: 3_600_000 },
      { deps: { now: () => NOON - 2 * DAY } })
    mirror(harness)
    for (const [id, shade] of [['one', 20], ['two', 60]] as const) {
      await harness.camera.send(harness.event('motion', await harness.frames(1, undefined, [shade]), { id, at: NOON - 2 * DAY }))
      await until(() => recordOf(harness, id)?.status === 'parsed', `record ${id}`)
    }
    await harness.fiber.dispose()
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const deleteImage = vi.spyOn(LocalAttachmentStore.prototype, 'deleteImage')
    let deletions: number
    try {
      deleteImage.mockImplementation(async () => { await gate; return true })
      const restarted = harness.remount({ now: () => NOON })
      await until(() => deleteImage.mock.calls.length === 1, 'first frame deletion')
      const disposed = restarted.dispose()
      release()
      await disposed
      deletions = deleteImage.mock.calls.length
    } finally {
      deleteImage.mockRestore()
    }
    expect(deletions).toBe(1)
    expect(records.get(harness)?.size).toBe(1)
  })

  it('logs a failed sweep and keeps sweeping', async () => {
    const harness = await start([], { sweepIntervalMs: 20 }, { deps: { now: () => { throw new Error('clock unavailable') } } })
    await until(() => harness.logs.filter(log => log.text.startsWith('camera-watch: history sweep failed')).length >= 2, 'two failed sweeps')
  })
})
