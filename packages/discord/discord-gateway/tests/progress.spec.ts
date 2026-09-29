/** The one "still working" notice a long inbound turn posts, and every path that cancels it. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TURN_PROGRESS_NOTICE } from '../src/conversation.ts'
import type { ConversationLane } from '../src/types.ts'
import { CHANNEL, USER, harness, inbound } from './support.ts'

const LANE_USER = '138391763999129602'
const LANE_CHANNEL = '1472404859679670499'
const owners: { dispose: () => Promise<void> }[] = []

function opened(options: Parameters<typeof harness>[0] = {}) {
  const h = harness({ replyText: 'answer', hang: true, turnTimeoutMs: 10_000, turnProgressNoticeMs: 3_000, ...options })
  owners.push(h.router)
  return h
}

const progress = (h: ReturnType<typeof harness>) => h.posted.filter(post => post.content === TURN_PROGRESS_NOTICE)

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(owners.splice(0).map(owner => owner.dispose()))
})

describe('Discord turn progress notice', () => {
  it('posts one notice in the channel once the turn outlives the threshold, then the answer', async () => {
    vi.useFakeTimers()
    const h = opened()
    h.router.handle(inbound())
    await vi.advanceTimersByTimeAsync(2_999)
    expect(progress(h)).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(progress(h)).toEqual([{ content: TURN_PROGRESS_NOTICE, channelId: CHANNEL, token: 'tok' }])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(progress(h)).toHaveLength(1)
    h.releaseIdle()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.posted.map(post => post.content)).toEqual([TURN_PROGRESS_NOTICE, 'answer'])
  })

  it('posts nothing when the turn settles before the threshold', async () => {
    vi.useFakeTimers()
    const h = opened()
    h.router.handle(inbound())
    await vi.advanceTimersByTimeAsync(1_000)
    h.releaseIdle()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.posted.map(post => post.content)).toEqual(['answer'])
  })

  it('posts nothing when disabled', async () => {
    vi.useFakeTimers()
    const h = opened({ turnProgressNoticeMs: 0 })
    h.router.handle(inbound())
    await vi.advanceTimersByTimeAsync(9_000)
    expect(h.posted).toHaveLength(0)
    h.releaseIdle()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.posted.map(post => post.content)).toEqual(['answer'])
  })

  it('keeps one notice for the running turn while a later message waits on the channel tail', async () => {
    vi.useFakeTimers()
    const h = opened()
    h.router.handle(inbound())
    await vi.advanceTimersByTimeAsync(1_000)
    h.router.handle(inbound({ id: 'm2', content: 'also check the wire' }))
    await vi.advanceTimersByTimeAsync(4_000)
    expect(progress(h)).toHaveLength(1)
    expect(h.calls.filter(call => call.startsWith('followup:'))).toEqual(['followup:is the build green?'])
  })

  it('is cancelled by a turn timeout that comes first', async () => {
    vi.useFakeTimers()
    const h = opened({ turnTimeoutMs: 2_000 })
    h.router.handle(inbound())
    await vi.advanceTimersByTimeAsync(2_000)
    expect(h.posted.map(post => post.content)).toEqual([expect.stringContaining('request timed out')])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(progress(h)).toHaveLength(0)
  })

  it('is cancelled when /new releases the conversation', async () => {
    vi.useFakeTimers()
    const h = opened()
    h.router.handle(inbound())
    await vi.advanceTimersByTimeAsync(1_000)
    h.router.handle(inbound({ id: 'reset', content: '/new' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls).toContain('dispose')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(progress(h)).toHaveLength(0)
  })

  it('is cancelled when the router is disposed', async () => {
    vi.useFakeTimers()
    const h = opened()
    h.router.handle(inbound())
    await vi.advanceTimersByTimeAsync(1_000)
    const disposed = h.router.dispose()
    await vi.advanceTimersByTimeAsync(0)
    h.releaseIdle()
    await vi.advanceTimersByTimeAsync(5_000)
    await disposed
    expect(progress(h)).toHaveLength(0)
  })

  it('posts nothing when the delay seam resolves after the turn settled', async () => {
    const h = opened({ manualWait: true, hang: false })
    h.router.handle(inbound())
    await vi.waitFor(() => { expect(h.posted.map(post => post.content)).toEqual(['answer']) })
    for (const resolve of h.waitResolvers.splice(0)) resolve()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(progress(h)).toHaveLength(0)
  })

  it('posts a lane user\'s notice in that user\'s own direct-message channel', async () => {
    vi.useFakeTimers()
    const lane: ConversationLane = { userId: LANE_USER, workspacePath: '/family', agentPreset: 'mamabear',
      permissionPreset: 'read-only', excludedPresetCommands: ['export'] }
    const h = opened({ allowedUserIds: [USER, LANE_USER], userLanes: new Map([[LANE_USER, lane]]) })
    h.router.handle(inbound({ authorId: LANE_USER, channelId: LANE_CHANNEL }))
    await vi.advanceTimersByTimeAsync(3_000)
    expect(progress(h)).toEqual([{ content: TURN_PROGRESS_NOTICE, channelId: LANE_CHANNEL, token: 'tok' }])
    expect(h.table.records.get(LANE_CHANNEL)?.lane).toBe(LANE_USER)
  })
})
