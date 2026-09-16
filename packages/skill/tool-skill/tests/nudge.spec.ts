import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, Session, SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { emitAgentEvent, type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as toolSkill from '@deepseek-ai/dsh-tool-skill'

const testToolSignal = new AbortController().signal

interface Harness {
  ctx: Context
  agent: Agent
  injected: UserMessage[]
  fiber: { dispose(): Promise<void> }
  call: (name?: string) => Promise<void>
}

/** Boot the plugin with a counting-friendly dummy tool and an inject-capturing Agent. */
async function harness(
  nudgeAfterToolCalls?: number,
  headerExtra?: { readonly origin?: 'subagent' },
): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SkillRegistry)
  const injected: UserMessage[] = []
  const id = SessionId('nudge-agent')
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd: '/workspace', isSeeded: false,
    ...(headerExtra ?? {}),
  })
  const agent: Agent = {
    id,
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: (message) => { injected.push(message) },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  for (const name of ['probe', 'skill_manage']) {
    ctx.tools.register(defineContentToolFixture({
      name,
      description: `fixture ${name}`,
      parameters: {},
      execute: async () => [{ type: 'text' as const, text: 'ok' }],
    }))
  }
  const fiber = await ctx.plugin(toolSkill, nudgeAfterToolCalls === undefined ? {} : { nudgeAfterToolCalls })
  let callIndex = 0
  return {
    ctx,
    agent,
    injected,
    fiber,
    call: async (name = 'probe') => {
      callIndex += 1
      const result = await ctx.tools.execute({
        signal: testToolSignal,
        callId: ToolCallId(`nudge-call-${String(callIndex)}`),
        name,
        arguments: {},
        agent,
      })
      expect(result.isError).toBe(false)
    },
  }
}

const stopTurn = (h: Harness): void => {
  emitAgentEvent(h.ctx, h.agent, 'agent/turn-stopping', { turn: 1, signal: testToolSignal })
}

describe('skill nudge', () => {
  it('stays silent by default however many tools a turn used', async () => {
    const h = await harness()
    for (let i = 0; i < 5; i += 1) await h.call()
    stopTurn(h)
    expect(h.injected).toEqual([])
  })

  it('stays silent below the threshold and injects once at it', async () => {
    const h = await harness(3)
    await h.call()
    await h.call()
    stopTurn(h)
    expect(h.injected).toEqual([])
    await h.call()
    await h.call()
    await h.call()
    stopTurn(h)
    expect(h.injected).toHaveLength(1)
    const notice = h.injected[0]
    expect(notice?.source.kind).toBe('skill-nudge')
    if (notice?.source.kind !== 'skill-nudge') return
    expect(notice.source.toolCalls).toBe(3)
    expect(notice.source.form).toBe('notice')
    const text = notice.content[0]
    expect(text?.type === 'text' && text.text).toContain('This turn used 3 tool calls.')
    expect(text?.type === 'text' && text.text).toContain('save it as a skill with `skill_manage`')
  })

  it('stays silent when the turn already managed a skill', async () => {
    const h = await harness(2)
    await h.call()
    await h.call('skill_manage')
    stopTurn(h)
    expect(h.injected).toEqual([])
  })

  it('consumes the tally at the stop so each turn counts fresh', async () => {
    const h = await harness(2)
    await h.call()
    await h.call()
    stopTurn(h)
    expect(h.injected).toHaveLength(1)
    stopTurn(h)
    expect(h.injected).toHaveLength(1)
    await h.call()
    await h.call()
    stopTurn(h)
    expect(h.injected).toHaveLength(2)
  })

  it('stops nudging once the plugin fiber is disposed', async () => {
    const h = await harness(2)
    await h.call()
    await h.call()
    await h.fiber.dispose()
    stopTurn(h)
    expect(h.injected).toEqual([])
  })

  it('ignores tool calls with no Agent to nudge', async () => {
    const h = await harness(1)
    const result = await h.ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('nudge-no-agent'),
      name: 'probe',
      arguments: {},
    })
    expect(result.isError).toBe(false)
    stopTurn(h)
    expect(h.injected).toEqual([])
  })

  it('never tallies or nudges a delegated subagent session', async () => {
    const h = await harness(2, { origin: 'subagent' })
    for (let i = 0; i < 5; i += 1) await h.call()
    stopTurn(h)
    expect(h.injected).toEqual([])
  })
})
