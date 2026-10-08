import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId, type SessionHeader, type UserMessage } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as toolSkillManage from '@deepseek-ai/dsh-tool-skill-manage'

interface Harness {
  ctx: Context
  agent: Agent
  fiber: { dispose(): Promise<void> }
}

async function harness(threshold = 2, origin?: 'subagent', seed?: Session): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SkillRegistry)
  const id = SessionId('nudge-agent')
  const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd: '/workspace', isSeeded: false, ...origin ? { origin } : {} }
  const session = Session.create(id, seed?.snapshotEvents(), header)
  const agent: Agent = {
    id, options: {}, session, inbox: unsupportedInbox(), status: 'running', ctx: new Context(),
    send: () => {}, followup: () => {}, steer: () => {}, inject: () => { throw new Error('nudge uses pre-step') },
    cancel() {}, runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
  }
  const fiber = await ctx.plugin(toolSkillManage, { nudgeAfterToolCalls: threshold })
  return { ctx, agent, fiber }
}

function completedTurn(h: Harness, turn: number, names: string[], reason: 'completed' | 'error' = 'completed', invoke = false, failedSkill = false): void {
  const { session } = h.agent
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Do the task.' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  if (invoke) session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'instructions' }],
    source: { kind: 'skill-invocation', name: 'sample', form: 'instructions' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  names.forEach((name, index) => {
    const callId = ToolCallId(`call-${String(turn)}-${String(index)}`)
    session.append('tool/call', { turn, step: 1, callId, name, arguments: '{}' })
    session.append('tool/result', {
      turn, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'ok' }], isError: failedSkill && name === 'skill' }),
    }, { surfaceOp: 'append' })
  })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: reason === 'completed'
    ? { kind: 'completed' } : { kind: 'error', error: { message: 'failed', code: 'UNKNOWN' } } })
}

async function nextStep(h: Harness, turn: number): Promise<UserMessage[]> {
  h.agent.session.append('turn/start', { turn })
  const decision = await agentEvents(h.ctx, h.agent).waterfall('agent/pre-step', {
    messages: [], turn, step: 1, signal: new AbortController().signal,
  }, () => Promise.resolve({ kind: 'enter' as const, messages: [] }))
  if (decision.kind === 'reject') return []
  for (const message of decision.messages) h.agent.session.append('user/message', message, { surfaceOp: 'append' })
  return decision.messages.filter(message => message.source.kind === 'skill-nudge')
}

describe('skill nudge', () => {
  it('stays disabled by default and below the configured threshold', async () => {
    const off = await harness(0)
    completedTurn(off, 1, ['probe', 'probe'])
    expect(await nextStep(off, 2)).toEqual([])
    const below = await harness(3)
    completedTurn(below, 1, ['probe', 'probe'])
    expect(await nextStep(below, 2)).toEqual([])
  })

  it('appears only after completed turn/end and only once in a Session after resume', async () => {
    const h = await harness()
    completedTurn(h, 1, ['probe', 'probe'], 'error')
    expect(await nextStep(h, 2)).toEqual([])
    h.agent.session.append('step/start', { turn: 2, step: 1 })
    h.agent.session.append('step/end', { turn: 2, step: 1 })
    h.agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    completedTurn(h, 3, ['probe', 'probe'])
    const resumed = await harness(2, undefined, h.agent.session)
    const notices = await nextStep(resumed, 4)
    expect(notices).toHaveLength(1)
    expect(notices[0]?.source).toMatchObject({ kind: 'skill-nudge', toolCalls: 2 })
    resumed.agent.session.append('step/start', { turn: 4, step: 1 })
    resumed.agent.session.append('step/end', { turn: 4, step: 1 })
    resumed.agent.session.append('turn/end', { turn: 4, reason: { kind: 'completed' } })
    completedTurn(resumed, 5, ['probe', 'probe'])
    const again = await harness(2, undefined, resumed.agent.session)
    expect(await nextStep(again, 6)).toEqual([])
  })

  it('does not nudge a model skill load or explicit user skill invocation', async () => {
    const model = await harness()
    completedTurn(model, 1, ['probe', 'skill', 'probe'])
    expect(await nextStep(model, 2)).toEqual([])
    const user = await harness()
    completedTurn(user, 1, ['probe', 'probe'], 'completed', true)
    expect(await nextStep(user, 2)).toEqual([])
  })

  it('allows a nudge when a skill load failed', async () => {
    const h = await harness()
    completedTurn(h, 1, ['probe', 'skill'], 'completed', false, true)
    expect(await nextStep(h, 2)).toHaveLength(1)
  })

  it('uses singular wording for one completed tool result', async () => {
    const h = await harness(1)
    completedTurn(h, 1, ['probe'])
    const notices = await nextStep(h, 2)
    expect(notices[0]?.source).toMatchObject({ kind: 'skill-nudge', summary: '1 tool call without a skill' })
    const content = notices[0]?.content[0]
    expect(content?.type).toBe('text')
    if (content?.type === 'text') expect(content.text).toContain('1 tool call.')
  })

  it('never nudges a delegated child, including after resume', async () => {
    const h = await harness(2, 'subagent')
    completedTurn(h, 1, ['probe', 'probe'])
    const resumed = await harness(2, 'subagent', h.agent.session)
    expect(await nextStep(resumed, 2)).toEqual([])
  })

  it('stops contributing after its plugin fiber is disposed', async () => {
    const h = await harness()
    completedTurn(h, 1, ['probe', 'probe'])
    await h.fiber.dispose()
    expect(await nextStep(h, 2)).toEqual([])
  })
})
