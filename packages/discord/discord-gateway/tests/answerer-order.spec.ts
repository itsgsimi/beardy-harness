/** Discord owns its interactions even when another surface connected before the gateway mounted. */
import { Context } from '@deepseek-ai/cordis'
import * as Remotes from '@deepseek-ai/dsh-api-remotes'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, expect, it, vi } from 'vitest'
import { harness, inbound } from './support.ts'

const contexts: Context[] = []
const routers: ReturnType<typeof harness>[] = []

afterEach(async () => {
  for (const h of routers.splice(0)) {
    h.controller.abort()
    h.releaseIdle()
    await h.router.dispose()
  }
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

it.each(['approval/request', 'user-questions/request'] as const)(
  'delivers %s ahead of an earlier remote answerer and delegates other agents', async (event) => {
    const ctx = new Context()
    contexts.push(ctx)
    const remote = vi.fn(async () => event === 'approval/request' ? 'rejected' as const : { answers: [] })
    // The remote peer is stubbed; the Host bridge and Cordis dispatcher are real.
    ctx.provide('typertGateway', {
      registerRemoteEvents(source) {
        const controller = new AbortController()
        const pump = (async () => {
          for await (const frame of source(controller.signal)) {
            if ('context' in frame) frame.resolve({ kind: 'result', value: await remote() })
          }
        })()
        return async () => { controller.abort(); await pump }
      },
    } as Pick<Context['typertGateway'], 'registerRemoteEvents'> as Context['typertGateway'])
    await ctx.plugin(Remotes)
    const h = harness({ eventContext: ctx, hang: true, manualWait: true })
    routers.push(h)
    h.router.handle(inbound())
    await vi.waitFor(() => { expect(h.calls.some(call => call.startsWith('followup:'))).toBe(true) })
    const agent = Object.assign(h.agent, { ctx }) as unknown as Agent
    const dispatch = (owner: Agent) => event === 'approval/request'
      ? ctx.waterfall(scopeTarget(owner, owner), event, { agent: owner, toolName: 'bash' }, async () => 'unavailable' as const)
      : ctx.waterfall(scopeTarget(owner, owner), event, {
        agent: owner, questions: [{ id: 'q1', question: 'Continue?' }],
      }, async () => ({ answers: [] }))
    const result = dispatch(agent)
    await vi.waitFor(() => { expect(h.prompts).toHaveLength(1) })
    expect(remote).not.toHaveBeenCalled()
    h.router.handle(inbound({ id: 'answer', content: 'yes' }))
    await expect(result).resolves.toEqual(event === 'approval/request'
      ? 'allowed-once' : { answers: [{ id: 'q1', selected: [], custom: 'yes' }] })
    await dispatch({ ctx } as Agent)
    expect(remote).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)
    await dispatch(agent)
    expect(h.prompts).toHaveLength(1)
  },
)
