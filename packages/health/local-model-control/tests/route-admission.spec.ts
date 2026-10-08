import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { installRouteAdmission, type LocalModelStatus, type UnloadIntent } from '../src/index.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

const intent: UnloadIntent = { by: 'Goran', at: '2026-09-27T18:00:00.000Z' }

/** Status double whose unloaded routes the test changes between turns. */
function status(unloaded: Set<string>): LocalModelStatus {
  return {
    unloadedForRoute: provider => unloaded.has(provider) ? { backend: 'ornith', intent } : undefined,
    unloadedForHealthUrl: () => undefined,
    backends: () => [],
  }
}

/** Run one user turn through the production AgentLoop with route admission installed on the Host. */
async function runTurn(unloaded: Set<string>, options: { switchTo?: string } = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  installRouteAdmission(ctx, status(unloaded))
  const harness = await mountAgentLoopTestHarness(ctx)
  const local = new MockAdapter([textResponse('local answer')])
  const remote = new MockAdapter([textResponse('remote answer')])
  ctx.llm.registerAdapter(['local'], local)
  ctx.llm.registerAdapter(['remote'], remote)
  const agent = await harness.create(SessionId('route-admission'), { provider: 'remote', model: 'remote-model' })
  const { switchTo } = options
  if (switchTo !== undefined) {
    // An Agent-scoped listener registered after the Host listener replaces the route, as model selection does.
    agent.ctx.on('agent/request', async (_payload, next) => ({ ...await next(), provider: switchTo, model: `${switchTo}-model` }))
  }
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const events = agent.session.snapshotEvents()
  const end = events.at(-1)
  return { local, remote, events, reason: end?.type === 'turn/end' ? end.data.reason : undefined }
}

describe('local model route admission', () => {
  it('fails an Agent request on an unloaded route before the adapter receives it or a request header is logged', async () => {
    const { local, remote, events, reason } = await runTurn(new Set(['local']), { switchTo: 'local' })
    expect(local.requests).toEqual([])
    expect(remote.requests).toEqual([])
    expect(events.some(event => event.type === 'request/header')).toBe(false)
    expect(reason?.kind).toBe('error')
    expect(reason?.kind === 'error' ? reason.error : undefined).toMatchObject({
      code: 'LOCAL_MODEL_UNLOADED',
      message: 'local model unloaded: ornith was unloaded by Goran at 2026-09-27T18:00:00.000Z',
    })
  })

  it('admits requests whose final route is loaded, including a route an Agent listener switched away from', async () => {
    const loaded = await runTurn(new Set())
    expect(loaded.remote.requests).toHaveLength(1)
    expect(loaded.reason?.kind).toBe('completed')

    const switched = await runTurn(new Set(['remote']), { switchTo: 'local' })
    expect(switched.remote.requests).toEqual([])
    expect(switched.local.requests).toHaveLength(1)
    expect(switched.reason?.kind).toBe('completed')
  })

  it('removes the check when the owning context is disposed', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const fiber = await ctx.plugin((inner: Context) => { installRouteAdmission(inner, status(new Set(['remote']))) })
    await fiber.dispose()
    const harness = await mountAgentLoopTestHarness(ctx)
    const remote = new MockAdapter([textResponse('remote answer')])
    ctx.llm.registerAdapter(['remote'], remote)
    const agent = await harness.create(SessionId('route-admission-disposed'), { provider: 'remote', model: 'remote-model' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(remote.requests).toHaveLength(1)
  })
})
