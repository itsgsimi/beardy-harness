import { describe, expect, it } from 'vitest'
import { CHANNEL, drain, harness, inbound } from './support.ts'

describe('idle release and expiry', () => {
  it('releases the live agent after silence and resumes on the next message', async () => {
    const h = harness({ replyText: 'ok', idleReleaseMs: 10 })
    h.router.handle(inbound())
    await drain()
    expect(h.handle.dispose).toHaveBeenCalledTimes(1)
    expect(h.table.records.get(CHANNEL)).toBeDefined()

    h.router.handle(inbound({ id: 'm2', content: 'back again' }))
    await drain()
    expect(h.calls.some(call => call.startsWith('agent-resume:'))).toBe(true)
    expect(h.calls).toContain('followup:back again')
  })

  it('cancels a pending release when a message arrives first', async () => {
    const h = harness({ replyText: 'ok', idleReleaseMs: 40 })
    h.router.handle(inbound())
    await new Promise(resolve => setTimeout(resolve, 10))
    h.router.handle(inbound({ id: 'm2', content: 'still here' }))
    await drain()
    expect(h.handle.dispose).not.toHaveBeenCalled()
    expect(h.calls.filter(call => call === 'agent-create')).toHaveLength(1)
  })

  it('never releases while a turn is in progress', async () => {
    const h = harness({ replyText: 'slow', hang: true, idleReleaseMs: 5, turnTimeoutMs: 5_000 })
    h.router.handle(inbound())
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.handle.dispose).not.toHaveBeenCalled()
    h.releaseIdle()
    await drain()
    expect(h.posted).toHaveLength(1)
  })

  it('reports a disposal that fails during idle release', async () => {
    const h = harness({ replyText: 'ok', idleReleaseMs: 5 })
    h.handle.dispose.mockRejectedValueOnce(new Error('dispose hung up'))
    h.router.handle(inbound())
    await drain()
    expect(h.warnings.some(message => message.includes('idle release of Session'))).toBe(true)
  })

  it('releases and deletes the record when a command starts fresh', async () => {
    const h = harness({ replyText: 'ok' })
    h.router.handle(inbound())
    await drain()
    h.router.handle(inbound({ id: 'm2', content: '/new' }))
    await drain()
    expect(h.handle.dispose).toHaveBeenCalledTimes(1)
    expect(h.table.records.get(CHANNEL)).toBeUndefined()
    expect(h.posted.some(entry => entry.content.startsWith('Fresh conversation'))).toBe(true)

    h.router.handle(inbound({ id: 'm3', content: 'hello again' }))
    await drain()
    expect(h.calls.filter(call => call === 'agent-create')).toHaveLength(2)
  })
})
