import { describe, expect, it } from 'vitest'
import { drain, harness, inbound } from './support.ts'

describe('inbound debouncing', () => {
  it('joins messages from one window into a single newline-joined turn', async () => {
    const h = harness({ replyText: 'all three noted', inboundDebounceMs: 15 })
    h.router.handle(inbound({ id: 'm1', content: 'first line' }))
    h.router.handle(inbound({ id: 'm2', content: 'second line' }))
    h.router.handle(inbound({ id: 'm3', content: 'third line' }))
    await new Promise(resolve => setTimeout(resolve, 25))
    await drain()
    expect(h.calls).toContain('followup:first line\nsecond line\nthird line')
    expect(h.calls.filter(call => call.startsWith('followup:'))).toHaveLength(1)
  })

  it('extends the window while messages keep arriving', async () => {
    const h = harness({ replyText: 'ok', inboundDebounceMs: 20 })
    h.router.handle(inbound({ id: 'm1', content: 'one' }))
    await new Promise(resolve => setTimeout(resolve, 10))
    h.router.handle(inbound({ id: 'm2', content: 'two' }))
    await new Promise(resolve => setTimeout(resolve, 12))
    expect(h.calls.filter(call => call.startsWith('followup:'))).toHaveLength(0)
    await drain()
    expect(h.calls).toContain('followup:one\ntwo')
  })

  it('starts a new window after the previous turn drained', async () => {
    const h = harness({ replyText: 'ok', inboundDebounceMs: 5 })
    h.router.handle(inbound({ id: 'm1', content: 'batch one' }))
    await drain()
    h.router.handle(inbound({ id: 'm2', content: 'batch two' }))
    await drain()
    expect(h.calls).toContain('followup:batch one')
    expect(h.calls).toContain('followup:batch two')
  })

  it('answers every message immediately when the window is zero', async () => {
    const h = harness({ replyText: 'ok', inboundDebounceMs: 0 })
    h.router.handle(inbound({ id: 'm1', content: 'now' }))
    h.router.handle(inbound({ id: 'm2', content: 'also now' }))
    await drain()
    expect(h.calls).toContain('followup:now')
    expect(h.calls).toContain('followup:also now')
  })

  it('drains a waiting batch before running an arriving command', async () => {
    const h = harness({ replyText: 'ok', inboundDebounceMs: 50 })
    h.router.handle(inbound({ id: 'm1', content: 'queued text' }))
    h.router.handle(inbound({ id: 'm2', content: '/status' }))
    await drain()
    // The command runs immediately, before the flushed batch has opened its Session; the queued
    // text is never dropped on account of the command arriving.
    expect(h.calls).toContain('followup:queued text')
    expect(h.posted.some(entry => entry.content.startsWith('No conversation yet'))).toBe(true)
  })

  it('ignores a timer that fires after its batch was already flushed', async () => {
    const h = harness({ replyText: 'ok', inboundDebounceMs: 50, manualWait: true })
    h.router.handle(inbound({ id: 'm1', content: 'queued text' }))
    // The command flushes the batch and cancels its timer; a late resolution of the old wait must
    // not enqueue the batch a second time.
    h.router.handle(inbound({ id: 'm2', content: '/status' }))
    await drain()
    h.waitResolvers[0]?.()
    await drain()
    expect(h.calls.filter(call => call.startsWith('followup:'))).toHaveLength(1)
  })

  it('drops nothing when the router is disposed mid-window', async () => {
    const h = harness({ replyText: 'ok', inboundDebounceMs: 5_000 })
    h.router.handle(inbound({ id: 'm1', content: 'never arrives' }))
    await h.router.dispose()
    await drain()
    expect(h.calls.filter(call => call.startsWith('followup:'))).toHaveLength(0)
  })
})
