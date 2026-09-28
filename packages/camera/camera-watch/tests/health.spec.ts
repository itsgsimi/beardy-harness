import { afterEach, describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { ClassificationHealth, shortCause, TURN_FAILURE_CODES } from '../src/health.ts'
import { RECOVERY_NOTICE_TEXT, renderFailureNotice } from '../src/notice.ts'
import { cameraWatchDomainSpec } from '../src/history.ts'
import { NOON, until, verdictText, VisionAdapter, watchHarness } from './support.ts'
import type { WatchHarness } from './support.ts'

const HOUR = 3_600_000
const INTERVAL = 6 * HOUR
const CHANNEL = '123456789012345678'
const CRASH: StreamChunk[] = [{ type: 'finish', reason: { kind: 'error', failure: { code: 'UPSTREAM', message: 'model crashed' } } }]
const PAUSED = 'Motion alerts are paused; doorbell presses still post.'

const harnesses: WatchHarness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose()
})

async function start(...args: Parameters<typeof watchHarness>): Promise<WatchHarness> {
  const harness = await watchHarness(...args)
  harnesses.push(harness)
  return harness
}

function windowId(at: number): string {
  return `camera-watch:classification-failing:${String(Math.floor(at / INTERVAL) * INTERVAL)}`
}

/** Collect the ids of every committed history record. */
function recorded(harness: WatchHarness): Set<string> {
  const ids = new Set<string>()
  harness.ctx.on('domain/changed', (change) => {
    if (change.domain === cameraWatchDomainSpec.name && change.table === 'events' && change.operation !== 'deleted') ids.add(change.key)
  })
  return ids
}

function logged(harness: WatchHarness, type: string, prefix: string): string[] {
  return harness.logs.filter(log => log.type === type && log.text.startsWith(prefix)).map(log => log.text)
}

describe('ClassificationHealth', () => {
  it('raises a route failure at once and at most once per interval, in epoch-aligned windows', () => {
    const health = new ClassificationHealth({ threshold: 3, intervalMs: INTERVAL })
    expect(health.routeFailed('MODEL_UNAVAILABLE', 'no adapter', NOON)).toEqual({ kind: 'failing', id: windowId(NOON), code: 'MODEL_UNAVAILABLE', cause: 'no adapter' })
    expect(health.routeFailed('MODEL_NOT_VISION', 'no image input', NOON + INTERVAL - 1)).toBeUndefined()
    expect(health.routeFailed('MODEL_NOT_VISION', 'no image input', NOON + INTERVAL)).toMatchObject({ id: windowId(NOON + INTERVAL), code: 'MODEL_NOT_VISION' })
    expect(windowId(NOON + INTERVAL)).not.toBe(windowId(NOON))
  })

  it('raises turn failures only at the threshold in a row, ignores other codes, and restarts the run after an answer', () => {
    const health = new ClassificationHealth({ threshold: 3, intervalMs: INTERVAL })
    expect(TURN_FAILURE_CODES).toEqual(['TIMEOUT', 'TURN_FAILED', 'NO_ANSWER', 'SESSION_FAILED'])
    expect(health.turnFailed('TIMEOUT', NOON)).toBeUndefined()
    expect(health.turnFailed('NOT_PERSISTED', NOON)).toBeUndefined()
    expect(health.turnFailed('SESSION_FAILED', NOON)).toBeUndefined()
    expect(health.answered()).toBeUndefined()
    expect(health.turnFailed('TIMEOUT', NOON)).toBeUndefined()
    expect(health.turnFailed('TURN_FAILED', NOON)).toBeUndefined()
    expect(health.turnFailed('NO_ANSWER', NOON)).toEqual({ kind: 'failing', id: windowId(NOON), code: 'NO_ANSWER', cause: '3 classifications in a row' })
    expect(health.turnFailed('NO_ANSWER', NOON + HOUR)).toBeUndefined()
  })

  it('follows a failure notice with one recovery line', () => {
    const health = new ClassificationHealth({ threshold: 1, intervalMs: INTERVAL })
    expect(health.answered()).toBeUndefined()
    health.turnFailed('TIMEOUT', NOON)
    expect(health.answered()).toEqual({ kind: 'recovered', id: `${windowId(NOON)}:recovered` })
    expect(health.answered()).toBeUndefined()
    expect(health.turnFailed('TIMEOUT', NOON + HOUR)).toBeUndefined()
    expect(health.answered()).toBeUndefined()
  })
})

describe('shortCause', () => {
  it('quotes the first line of the innermost cause, bounded', () => {
    const inner = new Error('llm-pi-ai: reasoningEfforts offers no level beyond "off"\nsecond line')
    expect(shortCause(new Error('outer', { cause: new Error('middle', { cause: inner }) }))).toBe('llm-pi-ai: reasoningEfforts offers no level beyond "off"')
    expect(shortCause(new Error('ends here', { cause: null }))).toBe('ends here')
    expect(shortCause('plain text')).toBe('plain text')
    const long = shortCause(new Error('x'.repeat(300)))
    expect([long.length, long.endsWith('…')]).toEqual([200, true])
  })

  it('stops at a cyclic cause', () => {
    const first = new Error('first')
    const second = new Error('second', { cause: first })
    first.cause = second
    expect(shortCause(first)).toBe('second')
  })
})

describe('renderFailureNotice', () => {
  it('states the code and cause, and whether doorbell presses still post', () => {
    expect(renderFailureNotice({ code: 'TIMEOUT', cause: '3 classifications in a row', dingNotifies: true }))
      .toBe(`⚠️ Camera classification is failing (TIMEOUT: 3 classifications in a row). ${PAUSED}`)
    expect(renderFailureNotice({ code: 'MODEL_UNAVAILABLE', cause: 'no adapter', dingNotifies: false }))
      .toBe('⚠️ Camera classification is failing (MODEL_UNAVAILABLE: no adapter). Motion alerts are paused.')
    expect(RECOVERY_NOTICE_TEXT).toBe('Camera classification recovered.')
  })
})

describe('camera watch route check', () => {
  it('resolves the host default route at start', async () => {
    const harness = await start([])
    await until(() => logged(harness, 'info', 'camera-watch: classifying with').length === 1, 'route check')
    expect(logged(harness, 'info', 'camera-watch: classifying with')).toEqual(['camera-watch: classifying with mock/vision-model'])
  })

  it('waits until the configured provider registers, then resolves it once while it stays registered', async () => {
    const harness = await start([], { modelSelection: { provider: 'late', model: 'eye' } })
    expect(logged(harness, 'info', 'camera-watch: classifying with')).toEqual([])
    harness.ctx.llm.registerAdapter(['late'], new VisionAdapter([]))
    await until(() => logged(harness, 'info', 'camera-watch: classifying with').length === 1, 'route check')
    harness.ctx.llm.registerAdapter(['other'], new VisionAdapter([]))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(logged(harness, 'info', 'camera-watch: classifying with')).toEqual(['camera-watch: classifying with late/eye'])
    expect(harness.notices).toEqual([])
  })

  it('logs a failed check with its cause chain, posts one failure notice, and keeps the host running', async () => {
    const harness = await start([], { modelSelection: { provider: 'late', model: 'eye' } }, { deps: { now: () => NOON } })
    const late = new VisionAdapter([])
    late.resolveError = new Error('catalog refused', { cause: new Error('llm-pi-ai: provider "late" model "eye" reasoningEfforts offers no level beyond "off"') })
    const registration = harness.ctx.llm.registerAdapter(['late'], late)
    await until(() => harness.notices.length === 1, 'failure notice')
    expect(logged(harness, 'error', 'camera-watch: model route check failed:')).toEqual([
      'camera-watch: model route check failed: camera-watch: modelSelection: provider "late" model "eye" cannot be resolved: catalog refused: '
        + 'llm-pi-ai: provider "late" model "eye" reasoningEfforts offers no level beyond "off"',
    ])
    expect(harness.notices).toEqual([{
      id: windowId(NOON), channelId: CHANNEL,
      text: `⚠️ Camera classification is failing (MODEL_UNAVAILABLE: llm-pi-ai: provider "late" model "eye" reasoningEfforts offers no level beyond "off"). ${PAUSED}`,
    }])

    registration()
    late.resolveError = undefined
    late.inputModalities = ['text']
    harness.ctx.llm.registerAdapter(['late'], late)
    await until(() => logged(harness, 'error', 'camera-watch: model route check failed:').length === 2, 'second check')
    expect(logged(harness, 'error', 'camera-watch: model route check failed:')[1])
      .toBe('camera-watch: model route check failed: provider "late" model "eye" declares no image input')
    expect(harness.notices).toHaveLength(1)
    expect(harness.ctx.tools.get('camera')).toBeDefined()
  })

  it('checks nothing once disposal has started', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let waiting: AbortSignal | undefined
    const sleep = async (_ms: number, signal: AbortSignal): Promise<void> => {
      waiting = signal
      await held
    }
    const harness = await start([], { modelSelection: { provider: 'late', model: 'eye' } }, { deps: { sleep } })
    harness.noticeReplies.push('refuse')
    await harness.camera.send(harness.event('motion', await harness.frames(1)))
    await until(() => waiting !== undefined, 'held failure notice retry')
    const disposal = harness.fiber.dispose()
    await until(() => waiting?.aborted === true, 'disposal start')
    harness.ctx.llm.registerAdapter(['late'], new VisionAdapter([]))
    release()
    await disposal
    expect(logged(harness, 'info', 'camera-watch: classifying with')).toEqual([])
  })
})

describe('camera watch failure notices', () => {
  it('posts one failure notice per interval across repeated route failures', async () => {
    const clock = { now: NOON }
    const harness = await start([], { modelSelection: { provider: 'absent', model: 'x' } }, { deps: { now: () => clock.now } })
    const ids = recorded(harness)
    for (const id of ['a', 'b', 'c']) await harness.camera.send(harness.event('motion', await harness.frames(1), { id }))
    await until(() => ids.size === 3, 'three records')
    expect(harness.notices.map(notice => notice.id)).toEqual([windowId(NOON)])
    expect(harness.notices[0]?.text).toMatch(/^⚠️ Camera classification is failing \(MODEL_UNAVAILABLE: .+\)\. /u)
    expect(harness.notices[0]?.text.endsWith(PAUSED)).toBe(true)
    expect(logged(harness, 'error', 'camera-watch: model route unavailable:')).toHaveLength(3)
    clock.now = NOON + INTERVAL
    await harness.camera.send(harness.event('motion', await harness.frames(1), { id: 'd' }))
    await until(() => harness.notices.length === 2, 'second failure notice')
    expect(harness.notices[1]?.id).toBe(windowId(NOON + INTERVAL))
  })

  it('posts a failure notice after the configured turn failures in a row and one recovery line after the next answer', async () => {
    const harness = await start([CRASH, verdictText({}), CRASH, '   ', verdictText({}), verdictText({})], { failureNoticeThreshold: 2 }, { deps: { now: () => NOON } })
    const ids = recorded(harness)
    for (const id of ['crash', 'ok', 'crash-again', 'blank', 'recovered', 'steady']) {
      await harness.camera.send(harness.event('motion', await harness.frames(1), { id }))
    }
    await until(() => ids.size === 6, 'six records')
    expect(harness.notices).toEqual([
      { id: windowId(NOON), channelId: CHANNEL, text: `⚠️ Camera classification is failing (NO_ANSWER: 2 classifications in a row). ${PAUSED}` },
      { id: `${windowId(NOON)}:recovered`, channelId: CHANNEL, text: 'Camera classification recovered.' },
    ])
    expect(logged(harness, 'warn', 'camera-watch: classification is failing')).toEqual(['camera-watch: classification is failing (NO_ANSWER: 2 classifications in a row)'])
    expect(logged(harness, 'info', 'camera-watch: classification recovered')).toHaveLength(1)
  })

  it('only logs failure and recovery without a channel', async () => {
    const harness = await start([], { modelSelection: { provider: 'absent', model: 'x' }, policy: { ding: false } }, { channel: false })
    const ids = recorded(harness)
    await harness.camera.send(harness.event('motion', await harness.frames(1), { id: 'blind' }))
    await until(() => ids.has('blind'), 'failed record')
    expect(logged(harness, 'warn', 'camera-watch: classification is failing (MODEL_UNAVAILABLE: ')).toHaveLength(1)
    harness.ctx.llm.registerAdapter(['absent'], new VisionAdapter([textResponse(verdictText({}))]))
    await until(() => logged(harness, 'info', 'camera-watch: classifying with').length === 1, 'route check')
    await harness.camera.send(harness.event('motion', await harness.frames(1), { id: 'seen' }))
    await until(() => ids.has('seen'), 'classified record')
    expect(logged(harness, 'info', 'camera-watch: classification recovered')).toHaveLength(1)
    expect(harness.notices).toEqual([])
  })
})
