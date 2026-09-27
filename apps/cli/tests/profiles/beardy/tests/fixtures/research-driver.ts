/** Shipped Beardy profile driver for native research process and restart evidence. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-research'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-web'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ResearchToolRequest } from '@deepseek-ai/dsh-tool-research'

/** The process emits one record after every assertion subject has settled. */
export interface ResearchDriverEvidence {
  phase: 'run' | 'reopen'
  runId: string
  firstStatus?: string
  secondStatus?: string
  sourceUrls?: string[]
  fetchedUrls?: string[]
  report?: string
  reopened?: string
  foreignDenied: boolean
  simultaneousRuns?: boolean
}

/** Driver input in the last CLI patch layer. */
export interface Config {
  phase: 'run' | 'reopen'
  runId?: string
  fixtureOrigin?: string
  query?: string
  provider: string
  model: string
}

export const name = 'research-e2e-driver'
export const inject = ['agents', 'tools', 'research', 'sessionPersistence', 'web']

function text(result: { isError?: boolean; content: readonly { type: string; text?: string }[] }): string {
  if (result.isError) throw new Error(`deep_research failed: ${JSON.stringify(result.content)}`)
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
}

function json(result: { isError?: boolean; content: readonly { type: string; text?: string }[] }): Record<string, unknown> {
  return JSON.parse(text(result)) as Record<string, unknown>
}

function stringField(value: Record<string, unknown>, field: string): string {
  const item = value[field]
  if (typeof item !== 'string') throw new Error(`research ${field} is not a string`)
  return item
}

async function readPages(
  call: (args: ResearchToolRequest) => Promise<{ isError?: boolean; content: readonly { type: string; text?: string }[] }>,
  action: 'status' | 'report', id: string): Promise<Record<string, unknown>> {
  let offset = 0
  let serialized = ''
  for (;;) {
    const page = json(await call({ action, id, offset }))
    if (typeof page.text !== 'string') throw new Error(`${action} returned no page text`)
    serialized += page.text
    if (page.next_offset === null) return JSON.parse(serialized) as Record<string, unknown>
    if (typeof page.next_offset !== 'number' || page.next_offset <= offset) throw new Error(`${action} returned an invalid offset`)
    offset = page.next_offset
  }
}

async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 1_800_000
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`research e2e timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** Mount a fixture fetch transport only for the keyless local page server. */
function fixtureFetch(ctx: Context, origin: string): void {
  const base = new URL(origin)
  ctx.effect(() => ctx.web.registerFetchProvider({
    id: 'research-fixture',
    available: () => true,
    fetch: async (request, signal) => {
      const url = new URL(request.url)
      if (url.origin !== base.origin) throw new Error('research fixture fetch refused a foreign origin')
      const response = await fetch(url, signal === undefined ? {} : { signal })
      return { url: response.url, statusCode: response.status,
        body: { kind: 'html' as const, content: await response.text() }, truncated: false }
    },
  }), 'research fixture fetch')
}

/** Run tool calls through the launched composition, then ask the launcher to exit. */
export function apply(ctx: Context, config: Config): void {
  const ready = ctx.get('appReady')
  const exit = ctx.get('appExit')
  if (ready === undefined || exit === undefined) throw new Error('research e2e requires the dsh launcher')
  if (config.fixtureOrigin !== undefined) fixtureFetch(ctx, config.fixtureOrigin)

  const run = async (): Promise<void> => {
    const owner = config.phase === 'reopen'
      ? await ctx.agents.resume({ resumeSessionId: SessionId('research-e2e-owner'),
        agentOptions: { provider: config.provider, model: config.model } })
      : await ctx.agents.create({ sessionId: SessionId('research-e2e-owner'),
        meta: { cwd: process.cwd() }, agentOptions: { provider: config.provider, model: config.model } })
    const foreign = await ctx.agents.create({ sessionId: SessionId(`research-e2e-foreign-${config.phase}`),
      meta: { cwd: process.cwd() },
      agentOptions: { provider: config.provider, model: config.model } })
    let sequence = 0
    const call = (agent: typeof owner.agent, args: ResearchToolRequest) => ctx.tools.execute({
      name: 'deep_research', arguments: args, agent, callId: ToolCallId(`research-e2e-${config.phase}-${++sequence}`),
      signal: new AbortController().signal,
    })
    const read = (agent: typeof owner.agent, action: 'status' | 'report', id: string) =>
      readPages(args => call(agent, args), action, id)
    try {
      if (config.phase === 'reopen') {
        if (config.runId === undefined) throw new Error('reopen requires runId')
        const report = await read(owner.agent, 'report', config.runId)
        const denied = await call(foreign.agent, { action: 'report', id: config.runId })
        process.stdout.write(`DSH_RESEARCH_E2E ${JSON.stringify({ phase: 'reopen', runId: config.runId,
          reopened: stringField(report, 'report'), foreignDenied: denied.isError } satisfies ResearchDriverEvidence)}\n`)
        return
      }

      const started = json(await call(owner.agent, { action: 'start', query: config.query ?? 'Current research evidence' }))
      const runId = started.id
      if (typeof runId !== 'string') throw new Error('research start returned no ID')
      const second = json(await call(owner.agent, { action: 'start', query: 'CANCEL_CASE second research run' }))
      const secondId = second.id
      if (typeof secondId !== 'string') throw new Error('second research start returned no ID')
      const firstBeforeCancel = await read(owner.agent, 'status', runId)
      const secondBeforeCancel = await read(owner.agent, 'status', secondId)
      const simultaneousRuns = firstBeforeCancel.status === 'running' && secondBeforeCancel.status === 'running'
      json(await call(owner.agent, { action: 'cancel', id: secondId }))
      let firstStatus: Record<string, unknown> = {}
      let secondStatus: Record<string, unknown> = {}
      await waitFor(async () => {
        firstStatus = await read(owner.agent, 'status', runId)
        secondStatus = await read(owner.agent, 'status', secondId)
        return firstStatus.status !== 'running' && secondStatus.status !== 'running'
      }, 'both terminal runs')
      if (firstStatus.status !== 'completed') {
        const persisted = await ctx.sessionPersistence.open(SessionId(runId), 'read')
        const events = (await persisted.read()).events
        await persisted.close()
        const stages = events.flatMap(event => event.type === 'research/checkpoint' && event.data.stageSessionId !== undefined
          ? [event.data.stageSessionId] : [])
        const stageEvents: unknown[] = []
        for (const stageId of stages.slice(0, 2)) {
          const stage = await ctx.sessionPersistence.open(stageId, 'read')
          stageEvents.push((await stage.read()).events.filter(event => event.type === 'assistant/attempt'
            || event.type === 'assistant/message' || event.type === 'turn/end'))
          await stage.close()
        }
        throw new Error(`first research run failed: ${JSON.stringify({ firstStatus, stageEvents })}`)
      }
      const report = await read(owner.agent, 'report', runId)
      const denied = await call(foreign.agent, { action: 'report', id: runId })
      const persisted = await ctx.sessionPersistence.open(SessionId(runId), 'read')
      let sourceUrls: string[]
      let fetchedUrls: string[]
      try {
        const events = (await persisted.read()).events
        sourceUrls = events.flatMap(event => event.type === 'research/source' && event.data.source !== undefined
          ? [event.data.source.url] : [])
        fetchedUrls = events.flatMap(event => event.type === 'research/source' && event.data.status === 'fetched'
          && event.data.finalUrl !== undefined ? [event.data.finalUrl] : [])
      } finally {
        await persisted.close()
      }
      process.stdout.write(`DSH_RESEARCH_E2E ${JSON.stringify({ phase: 'run', runId,
        firstStatus: stringField(firstStatus, 'status'), secondStatus: stringField(secondStatus, 'status'), sourceUrls, fetchedUrls,
        report: stringField(report, 'report'), foreignDenied: denied.isError, simultaneousRuns } satisfies ResearchDriverEvidence)}\n`)
    } finally {
      await foreign.dispose()
      await owner.dispose()
    }
  }

  ctx.effect(() => ready.onReady(() => {
    void run().then(() => { exit(0) }, (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
      exit(1)
    })
  }), 'research e2e driver')
}
