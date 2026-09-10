import { describe, expect, it, vi } from 'vitest'
import { CHANNEL, harness, inbound, record } from './support.ts'

describe('conversation controls during startup', () => {
  it.each([
    ['create', 'stop'], ['create', 'new'], ['resume', 'stop'], ['resume', 'new'],
  ] as const)('%s is cancelled by /%s before its late handle can start a turn', async (method, command) => {
    const previous = record()
    const h = harness({ ...(method === 'resume' ? { initialRecord: previous } : {}), replyText: 'answer' })
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<undefined>()
    if (method === 'create') {
      const create = h.ctx.agents.create.bind(h.ctx.agents)
      vi.spyOn(h.ctx.agents, 'create').mockImplementationOnce(async (options) => {
        const handle = await create(options)
        if (options.signal === undefined) throw new Error('opening has no cancellation signal')
        entered.resolve(options.signal)
        await release.promise
        return handle
      })
    } else {
      const resume = h.ctx.agents.resume.bind(h.ctx.agents)
      vi.spyOn(h.ctx.agents, 'resume').mockImplementationOnce(async (options) => {
        const handle = await resume(options)
        if (options.signal === undefined) throw new Error('opening has no cancellation signal')
        entered.resolve(options.signal)
        await release.promise
        return handle
      })
    }
    try {
      h.router.handle(inbound({ content: 'original message' }))
      const startupSignal = await entered.promise
      h.router.handle(inbound({ id: 'queued', content: 'queued before control' }))
      const controlled = h.router.execute(CHANNEL, `/${command}`)
      expect(startupSignal.aborted).toBe(true)
      let finished = false
      void controlled.then(() => { finished = true })
      expect(finished).toBe(false)
      release.resolve(undefined)
      await controlled
      expect(h.handle.dispose).toHaveBeenCalledTimes(1)
      expect(h.calls.some(call => call.startsWith('followup:'))).toBe(false)
      expect(h.warnings).toEqual([])
      expect(h.posted).toEqual([])
      expect(h.table.records.get(CHANNEL)).toEqual(method === 'resume' && command === 'stop' ? previous : undefined)
      h.router.handle(inbound({ id: 'next', content: 'message after control' }))
      await vi.waitFor(() => { expect(h.calls).toContain('followup:message after control') })
      expect(h.calls).not.toContain('followup:queued before control')
      expect(h.calls).not.toContain('followup:original message')
    } finally {
      release.resolve(undefined)
      h.controller.abort()
      await h.router.dispose()
      vi.restoreAllMocks()
    }
  })
})
