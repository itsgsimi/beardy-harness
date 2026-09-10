/** Production JSONL restart evidence through the real Agent resume lifecycle. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { DiscordWakeCoordinator } from '../src/wake.ts'
import type { ConversationRecord } from '../src/domain.ts'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as toolSchedule from '@deepseek-ai/dsh-schedule'
import {
  ScheduleId,
  createAfterScheduleRecord,
  foldScheduleEvents,
} from '@deepseek-ai/dsh-schedule'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Reminder acknowledged.' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    for (const chunk of response) yield chunk
  }
}

async function mountPersistence(root: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  return ctx
}

async function mountRuntime(root: string, adapter: RecordingAdapter): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(toolSchedule)
  return ctx
}

async function disposeContext(ctx: Context): Promise<void> {
  const index = contexts.indexOf(ctx)
  if (index >= 0) contexts.splice(index, 1)
  await ctx.fiber.dispose()
}

function waitForDispatch(ctx: Context, sessionId: SessionId): Promise<void> {
  return new Promise((resolve) => {
    const stop = ctx.on('session/event', (session, event) => {
      if (session.id !== sessionId
        || event.type !== 'schedule/change'
        || event.data.operation !== 'dispatch') return
      stop()
      resolve()
    })
  })
}

/** Read one stored session's header and full event log through a read handle. */
async function readStored(ctx: Context, id: SessionId) {
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try {
    return { header: handle.header, inheritedEventCount: handle.inheritedEventCount, events: await handle.read() }
  } finally {
    await handle.close()
  }
}


describe('Discord reminder wake after restart', () => {
  it('resumes only its recorded cold session and dispatches an overdue reminder without inbound work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-discord-wake-'))
    roots.push(root)
    const sessionId = SessionId('discord-reminder-restart')
    const first = await mountPersistence(root)
    const pending = first.sessions.create(sessionId, { meta: { cwd: root } })
    const schedule = createAfterScheduleRecord(ScheduleId('schedule-1'), 'Time to check the build.', 1, Date.now() - 60_000)
    pending.append('schedule/change', { version: 1, operation: 'create', schedule })
    const seed = await first.sessionPersistence.create(pending.header)
    await seed.append(pending.snapshotEvents())
    await seed.flush()
    await seed.close()
    await disposeContext(first)

    const adapter = new RecordingAdapter()
    const ctx = await mountRuntime(root, adapter)
    const records = new Map<string, ConversationRecord>([['channel', {
      channelId: 'channel', sessionId, agentPreset: 'beardy-discord', workspacePath: root,
      openedAt: 1, lastInboundAt: 1,
    }]])
    const table = {
      entries: () => records.entries(), get: (key: string) => records.get(key),
    } as unknown as KvTable<string, ConversationRecord>
    let live = false
    const done = Promise.withResolvers<undefined>()
    const wake = vi.fn(async (record: ConversationRecord) => {
      const dispatched = waitForDispatch(ctx, SessionId(record.sessionId))
      const handle = await ctx.agents.resume({ resumeSessionId: SessionId(record.sessionId),
        agentOptions: { provider: 'mock', model: 'mock' } })
      live = true
      await dispatched
      await handle.agent.whenIdle()
      await ctx.sessions.flush(handle.agent.session)
      done.resolve(undefined)
    })
    const coordinator = new DiscordWakeCoordinator(ctx, table, wake, () => live, 1000)
    try {
      await coordinator.start()
      await done.promise
      expect(wake).toHaveBeenCalledTimes(1)
      expect(adapter.requests).toHaveLength(1)
      const stored = await readStored(ctx, sessionId)
      expect(foldScheduleEvents(stored.events, stored.inheritedEventCount).active).toEqual([])
      expect(stored.events.some(event => event.type === 'assistant/message')).toBe(true)
    } finally {
      await coordinator.dispose()
    }
  })
})
