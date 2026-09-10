import { describe, expect, it, vi } from 'vitest'
import { isAdmitted } from '../src/conversation.ts'
import { parseMessageCreate } from '../src/gateway.ts'
import { harness, inbound } from './support.ts'

describe('Discord lifecycle controls', () => {
  it('admits an allowlisted DM whose Gateway payload omits the optional channel type', () => {
    const message = parseMessageCreate({ id: 'm', channel_id: 'c', author: { id: 'u' }, content: 'hello' })!
    const policy = { allowedUserIds: new Set(['u']), allowedChannelIds: new Set<string>(),
      guildRequireMention: true, botUserId: () => 'bot' }
    expect(isAdmitted(message, policy)).toBe(true)
    expect(isAdmitted({ ...message, guildId: 'g', channelType: 0 }, policy)).toBe(false)
  })

  it('cancels a running proactive turn from /stop', async () => {
    const h = harness({ replyText: 'answer', manualWait: true })
    try {
      h.router.handle(inbound())
      await vi.waitFor(() => { expect(h.posted).toHaveLength(1) })
      h.emitStatus(h.agent, 'running')
      h.router.handle(inbound({ id: 'm2', content: '/stop' }))
      await vi.waitFor(() => { expect(h.posted).toHaveLength(2) })
      expect(h.calls).toContain('cancel:{"kind":"user"}')
    } finally {
      h.controller.abort()
      await h.router.dispose()
    }
  })

  it('keeps a running proactive turn alive through an expired release timer', async () => {
    const h = harness({ replyText: 'answer', manualWait: true })
    try {
      h.router.handle(inbound())
      await vi.waitFor(() => { expect(h.posted).toHaveLength(1) })
      const release = h.waitResolvers.at(-1)!
      h.emitStatus(h.agent, 'running')
      release()
      await Promise.resolve()
      expect(h.handle.dispose).not.toHaveBeenCalled()
      h.emitStatus(h.agent, 'idle')
      h.waitResolvers.at(-1)!()
      await vi.waitFor(() => { expect(h.handle.dispose).toHaveBeenCalledTimes(1) })
    } finally {
      h.controller.abort()
      await h.router.dispose()
    }
  })
})
