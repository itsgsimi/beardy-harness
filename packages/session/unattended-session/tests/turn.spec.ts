import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId, SessionSeq, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { awaitTurn, lastAssistantText, lastTurnEndReason, sleep } from '../src/turn.ts'

function agentReturning(idle: () => Promise<void>): Agent {
  const id = SessionId('await-turn')
  return {
    ctx: new Context(), id, session: Session.create(id), options: {}, inbox: unsupportedInbox(), status: 'idle',
    send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel: () => {},
    runMaintenance: task => task(new AbortController().signal), whenIdle: idle,
  }
}

function assistantEvent(seq: number, text: string): SessionEvent<'assistant/message'> {
  return {
    seq: SessionSeq(seq), time: seq, type: 'assistant/message', surfaceOp: 'append',
    data: { turn: 1, step: 1, message: createAssistantMessage({
      content: [{ type: 'text', text }], source: { provider: 'fixture', model: 'fixture' },
    }), stream: [] },
  }
}

function endEvent(seq: number, reason: TurnEndReason): SessionEvent<'turn/end'> {
  return { seq: SessionSeq(seq), time: seq, type: 'turn/end', data: { turn: 1, reason } }
}

describe('sleep', () => {
  it('resolves when the delay passes', async () => {
    const controller = new AbortController()
    await sleep(1, controller.signal)
  })

  it('rejects with the abort reason when it is an error', async () => {
    const controller = new AbortController()
    const waiting = sleep(5_000, controller.signal)
    controller.abort(new Error('gone'))
    await expect(waiting).rejects.toThrow('gone')
  })

  it('rejects with a named error when the abort reason is not an error', async () => {
    const controller = new AbortController()
    const waiting = sleep(5_000, controller.signal)
    controller.abort('gone')
    await expect(waiting).rejects.toThrow('unattended session wait cancelled')
  })
})

describe('awaitTurn', () => {
  it('reports idle when the turn settles within the bound', async () => {
    const controller = new AbortController()
    const agent = agentReturning(() => Promise.resolve())
    expect(await awaitTurn(agent, { timeoutMs: 1_000, signal: controller.signal })).toBe('idle')
  })

  it('reports timeout when the bound expires first', async () => {
    const controller = new AbortController()
    const agent = agentReturning(() => new Promise<void>(() => {}))
    expect(await awaitTurn(agent, { timeoutMs: 1, signal: controller.signal })).toBe('timeout')
  })

  it('reports timeout when the delay seam rejects', async () => {
    const controller = new AbortController()
    const agent = agentReturning(() => new Promise<void>(() => {}))
    const wait = (): Promise<void> => Promise.reject(new Error('scheduler gone'))
    expect(await awaitTurn(agent, { timeoutMs: 1_000, signal: controller.signal, wait })).toBe('timeout')
  })

  it('reports timeout when the turn fails outright', async () => {
    const controller = new AbortController()
    const agent = agentReturning(() => Promise.reject(new Error('turn failed')))
    expect(await awaitTurn(agent, { timeoutMs: 1_000, signal: controller.signal })).toBe('timeout')
  })

  it('reports timeout when the caller cancels while waiting', async () => {
    const controller = new AbortController()
    const agent = agentReturning(() => new Promise<void>(() => {}))
    const waiting = awaitTurn(agent, { timeoutMs: 5_000, signal: controller.signal })
    controller.abort(new Error('listener disposed'))
    expect(await waiting).toBe('timeout')
  })
})

describe('lastAssistantText', () => {
  it('returns nothing when no assistant message followed the marker', () => {
    expect(lastAssistantText([], 0)).toBe('')
  })

  it('keeps the last text after the marker and skips earlier events', () => {
    const events: SessionEvent[] = [assistantEvent(1, 'first'), endEvent(2, { kind: 'completed' }), assistantEvent(3, 'second')]
    expect(lastAssistantText(events, 2)).toBe('second')
  })

  it('ignores an assistant message whose text blocks are empty', () => {
    const events: SessionEvent[] = [assistantEvent(1, '')]
    expect(lastAssistantText(events, 0)).toBe('')
  })
})

describe('lastTurnEndReason', () => {
  it('selects only a terminal event logged after admission', () => {
    const events: SessionEvent[] = [
      endEvent(1, { kind: 'completed' }), assistantEvent(2, ''),
      endEvent(3, { kind: 'error', error: { code: 'SERVER', message: 'failed' } }),
    ]
    expect(lastTurnEndReason(events, 2)).toEqual({ kind: 'error', error: { code: 'SERVER', message: 'failed' } })
    expect(lastTurnEndReason(events, 4)).toBeUndefined()
  })
})
