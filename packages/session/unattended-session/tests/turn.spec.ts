import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { awaitTurn, lastAssistantText, sleep } from '../src/turn.ts'

function agentReturning(idle: () => Promise<void>): Agent {
  return { whenIdle: idle } as unknown as Agent
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
    const events = [
      { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'first' }] } } },
      { seq: 2, type: 'turn/end', data: {} },
      { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'second' }] } } },
    ] as unknown as SessionEvent[]
    expect(lastAssistantText(events, 2)).toBe('second')
  })

  it('ignores an assistant message whose text blocks are empty', () => {
    const events = [
      { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '' }] } } },
    ] as unknown as SessionEvent[]
    expect(lastAssistantText(events, 0)).toBe('')
  })
})
