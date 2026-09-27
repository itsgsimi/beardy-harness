import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { ResearchRunId } from '@deepseek-ai/dsh-research'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import * as NativeResearch from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

const id = ResearchRunId('rp-native-00000000-0000-4000-8000-000000000001')

async function setup(config?: NativeResearch.Config) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const owner = { kind: 'session' as const, sessionId: SessionId('tool-caller') }
  const run = { id, owner, callerSessionId: owner.sessionId, query: 'A question', phase: 'running', round: 1,
    stageSessionIds: [], sourceCount: 1, createdAt: 1, updatedAt: 2, provider: 'mock', model: 'mock-model',
    reportAvailable: false }
  const service = {
    ownerFor: vi.fn(() => owner),
    start: vi.fn(async () => run), status: vi.fn(async () => ({ ...run, reason: 'stage stopped' })),
    list: vi.fn(async () => [run, { ...run, phase: 'completed' }]),
    report: vi.fn(async () => ({ runId: id, complete: true, markdown: '# 🧪 Report\nEvidence', pageChars: 8,
      sources: [{ url: 'https://example.org/a', title: 'Source A' }] })),
    cancel: vi.fn(async () => ({ requested: true })),
  }
  ctx.provide('research' as never, service as never)
  const fiber = await ctx.plugin(NativeResearch, config)
  const scope = ctx.plugin(() => {})
  const session = Session.create(owner.sessionId)
  const agent: Agent = {
    id: owner.sessionId, options: {}, session, inbox: unsupportedInbox(), status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(agent)
  const call = async (argumentsValue: NativeResearch.ResearchToolRequest, callId = 'tool-call', signal = new AbortController().signal) =>
    ctx.tools.execute({ name: 'deep_research', arguments: argumentsValue, callId: ToolCallId(callId), agent, signal })
  return { ctx, service, agent, owner, call, fiber }
}

function content(result: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['call']>>) {
  expect(result.isError, JSON.stringify(result)).toBe(false)
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error('expected text tool result')
  return JSON.parse(block.text) as Record<string, unknown>
}

it('registers five actions, starts with the exact call key, and disposes the tool', async () => {
  const { ctx, service, call, fiber } = await setup()
  const schema = ctx.tools.schemas().find(item => item.name === 'deep_research')
  expect(schema?.description).toContain('Read every report page')
  expect(schema?.parameters.properties).not.toHaveProperty('owner')
  expect(content(await call({ action: 'start', query: '  A question  ' }, 'first'))).toEqual({
    id, status: 'running', model: 'mock-model',
  })
  expect(service.start).toHaveBeenCalledWith(expect.objectContaining({ query: 'A question', requestKey: 'first' }))
  await fiber.dispose()
  expect(ctx.tools.schemas().map(item => item.name)).not.toContain('deep_research')
})

it('pages the immutable report by Unicode characters and emits viewer metadata on page zero', async () => {
  const { call } = await setup()
  const first = await call({ action: 'report', id })
  const firstPage = content(first)
  expect(first.meta).toMatchObject({ researchArtifact: { id, markdown: '# 🧪 Report\nEvidence',
    sources: [{ url: 'https://example.org/a', title: 'Source A' }] } })
  let serialized = String(firstPage.text)
  let next = firstPage.next_offset
  while (typeof next === 'number') {
    const result = await call({ action: 'report', id, offset: next })
    expect(result.meta).toEqual({})
    const parsed = content(result)
    serialized += String(parsed.text)
    next = parsed.next_offset
  }
  expect(Array.from(serialized)).toHaveLength(firstPage.total_chars as number)
  expect(JSON.parse(serialized)).toEqual({ report: '# 🧪 Report\nEvidence', complete: true,
    sources: [{ url: 'https://example.org/a', title: 'Source A' }] })
})

it('reads status and list pages, and cancellation only acknowledges the request', async () => {
  const { call, service, owner } = await setup({ summaryPageChars: 12, listLimit: 4 })
  expect(content(await call({ action: 'status', id }))).toMatchObject({ next_offset: 12 })
  expect(content(await call({ action: 'list', query: 'question' }))).toMatchObject({ next_offset: 12 })
  expect(service.list).toHaveBeenCalledWith(expect.objectContaining({ query: 'question', limit: 4 }))
  content(await call({ action: 'list' }))
  expect(service.list).toHaveBeenLastCalledWith({ owner, limit: 4 })
  expect(content(await call({ action: 'cancel', id }))).toEqual({ id, cancellation_requested: true })
})

it('declares read and execute presentation for both action kinds', async () => {
  const { ctx, agent } = await setup()
  const definition = ctx.tools.get('deep_research')
  expect(definition?.presentCall?.({ action: 'status', id })).toMatchObject({ kind: 'read' })
  expect(definition?.presentCall?.({ action: 'start', query: 'A' })).toMatchObject({ kind: 'execute' })
  expect(definition?.presentCall?.({ action: 'cancel', id })).toMatchObject({ kind: 'execute' })
  await expect(NativeResearch.executeResearch(ctx, { action: 'invalid' as NativeResearch.ResearchToolRequest['action'] }, {
    agent, callId: ToolCallId('invalid'), signal: new AbortController().signal,
  } as ToolRunContext, 16_000, 20)).rejects.toThrow('unknown deep_research action')
})

it.each([
  [{ action: 'start', query: ' ' }, 'non-empty query'],
  [{ action: 'start', query: 'A', offset: 1 }, 'page offset'],
  [{ action: 'cancel', id, offset: 1 }, 'page offset'],
  [{ action: 'report', id: 'wrong' }, 'unavailable'],
  [{ action: 'status' }, 'unavailable'],
  [{ action: 'status', id, offset: -1 }, 'non-negative'],
  [{ action: 'list', offset: 1.5 }, 'integer'],
  [{ action: 'report', id, offset: 9999 }, 'response length'],
] as const)('rejects invalid model input %j', async (args, message) => {
  const { call } = await setup()
  const result = await call(args)
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain(message)
})

it('rejects missing caller and an aborted execution', async () => {
  const { ctx, call } = await setup()
  const missing = await ctx.tools.execute({ name: 'deep_research', arguments: { action: 'list' },
    callId: ToolCallId('missing'), signal: new AbortController().signal })
  expect(missing.isError).toBe(true)
  const controller = new AbortController()
  controller.abort()
  expect((await call({ action: 'list' }, 'aborted', controller.signal)).isError).toBe(true)
})

it('rejects invalid direct configuration and a mounted bridge schema', async () => {
  const { ctx } = await setup()
  expect(() => { NativeResearch.apply(ctx, { summaryPageChars: 0 }) }).toThrow(/positive safe integers/)
  expect(() => { NativeResearch.apply(ctx, { listLimit: 101 }) }).toThrow(/positive safe integers/)
  ctx.tools.register(defineTool({ name: 'odysseus_research', description: 'bridge', parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }] },
    execute: async () => ({ text: 'bridge' }) }))
  expect(() => { NativeResearch.apply(ctx) }).toThrow(/disable the Odysseus bridge/)
})
