import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionSeq, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ConfiguredModelSelection } from '@deepseek-ai/dsh-unattended-session'
import { CONTINUITY_WITHOUT_NOTES, CONTINUITY_WITH_NOTES, createJobRunner, runPrompt, runTitle } from '../src/launch.ts'
import type { ScheduledJobSpec } from '../src/types.ts'
import { makeRegistry, storedRow } from './support.ts'

const FIRED_AT = Date.parse('2026-09-04T05:00:00.000Z')

const JOB: ScheduledJobSpec = {
  name: 'morning-brief',
  expression: '0 7 * * *',
  timezone: 'Europe/Zagreb',
  prompt: 'Summarize the feeds and today’s weather.',
  agentPreset: 'beardy',
  permissionPreset: 'danger-full-access',
  workspacePath: '/workspace',
  notes: '',
}

interface HarnessOptions {
  readonly modelSelection?: ConfiguredModelSelection
  readonly unresolvedModel?: boolean
  /** Assistant text the run commits; empty means the agent produced no text. */
  readonly replyText?: string
  /** Never settle whenIdle, so the bound expires. */
  readonly hang?: boolean
  readonly failStart?: 'preset' | 'workspace' | 'attach' | 'title'
  readonly turnTimeoutMs?: number
  /** Reject the delay seam instead of waiting on the runner's own sleep. */
  readonly rejectWait?: boolean
  /** Reject whenIdle, as a turn that fails outright does. */
  readonly rejectIdle?: boolean
  /** Terminal event the agent logs before becoming idle. */
  readonly ending?: TurnEndReason
  readonly omitEnding?: boolean
  /** Observe the effective turn bound without waiting for a real timer. */
  readonly wait?: (ms: number) => Promise<void>
}

/** Context carrying only what a scheduled run touches, recording each step. */
function harness(options: HarnessOptions = {}) {
  const calls: string[] = []
  const selections: string[] = []
  const events: SessionEvent[] = []
  let idleResolve: () => void = () => {}
  const agent = {
    session: {
      get seq(): number { return events.length },
      ownEvents: () => events,
    },
    followup(message: { content: readonly { text?: string }[] }) {
      calls.push(`followup:${message.content[0]?.text ?? ''}`)
      if (options.replyText !== undefined) {
        events.push({
          seq: SessionSeq(events.length + 1), time: Date.now(), type: 'assistant/message', surfaceOp: 'append',
          data: { turn: 1, step: 1, message: createAssistantMessage({
            content: [{ type: 'text', text: options.replyText }], source: { provider: 'fixture', model: 'fixture' },
          }), stream: [] },
        })
      }
      if (!options.omitEnding) {
        events.push({
          seq: SessionSeq(events.length + 1), time: Date.now(), type: 'turn/end',
          data: { turn: 1, reason: options.ending ?? { kind: 'completed' } },
        })
      }
    },
    whenIdle: () => {
      if (options.rejectIdle) return Promise.reject(new Error('turn failed'))
      return new Promise<void>((resolve) => {
        if (!options.hang) resolve()
        else idleResolve = resolve
      })
    },
  }
  const handle = { agent, dispose: vi.fn(async () => { calls.push('dispose') }) }
  const ctx = {
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    permissionPresets: {
      resolve: (name: string) => {
        if (options.failStart === 'preset') throw new Error(`unknown permission preset ${name}`)
        return {}
      },
      set: (_session: unknown, name: string) => { calls.push(`permission-set:${name}`) },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm', reasoningEffort: ReasoningEffortId('high') }) },
    llm: { resolveModelInfo: async (provider: string, model: string) => {
      if (options.unresolvedModel) throw new Error(`no adapter registered for provider "${provider}"`)
      return { provider, id: model, name: model,
        reasoning: { efforts: [{ id: ReasoningEffortId('medium'), name: 'Medium' }] } }
    } },
    agentPresets: {
      resolve: async (name: string) => {
        calls.push(`preset-resolve:${name}`)
        return { id: name }
      },
      acquireScope: async (name: string) => { calls.push(`scope:${name}`); return { key: {}, [Symbol.asyncDispose]: async () => {} } },
      mount: async (_ctx: unknown, name: string) => { calls.push(`mount:${name}`) },
    },
    workspaceRegistry: {
      create: async (path: string) => {
        calls.push(`workspace:${path}`)
        if (options.failStart === 'workspace') throw new Error('workspace failed')
        return {
          path,
          attachSession: async () => {
            calls.push('attach')
            if (options.failStart === 'attach') throw new Error('attach failed')
          },
          detachSession: async () => { calls.push('detach') },
        }
      },
    },
    agents: {
      create: async (createOptions: {
        setup?: (agentCtx: unknown) => Promise<void>
        agentOptions?: { provider?: string; model?: string; reasoningEffort?: string }
      }) => {
        calls.push('agent-create')
        selections.push(JSON.stringify(createOptions.agentOptions))
        await createOptions.setup?.({ on: () => () => {} })
        return handle
      },
    },
    sessionTitle: {
      rename: (_session: unknown, title: string) => {
        calls.push(`title:${title}`)
        if (options.failStart === 'title') throw new Error('title failed')
      },
    },
  }
  const controller = new AbortController()
  const testContext = new Context().extend(ctx)
  testContext.provide('llm', ctx.llm as never)
  const runner = createJobRunner({
    ctx: testContext,
    signal: controller.signal,
    turnTimeoutMs: options.turnTimeoutMs ?? 1_000,
    ...options.modelSelection === undefined ? {} : { modelSelection: options.modelSelection },
    ...(options.rejectWait === true ? { wait: () => Promise.reject(new Error('scheduler gone')) }
      : options.wait === undefined ? {} : { wait: options.wait }),
  })
  return {
    runner, calls, selections, events, handle, controller, ctx: testContext,
    releaseIdle: () => { idleResolve() },
  }
}

describe('runTitle', () => {
  it('uses the configured title when there is one', () => {
    expect(runTitle({ ...JOB, title: 'Morning brief' }, FIRED_AT)).toBe('Morning brief')
  })

  it('falls back to the job name and fire time', () => {
    expect(runTitle(JOB, FIRED_AT)).toBe(`morning-brief ${new Date(FIRED_AT).toISOString()}`)
  })
})

describe('run prompt', () => {
  it('asks for notes to be recorded when the job has none yet', () => {
    expect(runPrompt(JOB)).toBe(`${JOB.prompt}\n\n${CONTINUITY_WITHOUT_NOTES('morning-brief')}`)
  })

  it('carries earlier notes under the continuity instruction', () => {
    const text = runPrompt({ ...JOB, notes: 'Reported items A and B on Monday.' })
    expect(text).toContain(CONTINUITY_WITH_NOTES)
    expect(text).toContain('Notes from earlier runs:\nReported items A and B on Monday.')
  })

  it('uses the final answer for configured channel delivery', () => {
    expect(runPrompt({ ...JOB, deliverChannelId: 'channel-9' })).toContain(
      'Your final answer will be delivered to the configured channel automatically. Put the content to deliver in your final answer; do not send the same content separately with discord_send.',
    )
    expect(runPrompt(JOB)).not.toContain('automatically')
  })
})

describe('job runner', () => {
  it('inherits the full default selection when no cron choice is configured', async () => {
    const h = harness()
    await h.runner.run(JOB, FIRED_AT)
    expect(h.selections).toContain('{"provider":"p","model":"m","reasoningEffort":"high"}')
  })

  it('uses a configured job override ahead of the cron-wide selection', async () => {
    const h = harness({ modelSelection: { provider: 'top', model: 'top-model', reasoningEffort: 'medium' } })
    await h.runner.run({ ...JOB, modelSelection: { provider: 'job', model: 'job-model', reasoningEffort: 'medium' } }, FIRED_AT)
    expect(h.selections).toContain('{"provider":"job","model":"job-model","reasoningEffort":"medium"}')
  })

  it('applies the cron-wide selection to a stored job without an override', async () => {
    const h = harness({ modelSelection: { provider: 'top', model: 'top-model', reasoningEffort: 'medium' } })
    const { registry } = makeRegistry([], { stored: [storedRow('stored-brief')] })
    const stored = registry.find('stored-brief')
    expect(stored?.origin).toBe('stored')
    if (stored === undefined) throw new Error('stored job missing')
    await h.runner.run(stored, FIRED_AT)
    expect(h.selections).toContain('{"provider":"top","model":"top-model","reasoningEffort":"medium"}')
    expect(h.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' })
  })

  it('refuses an effort absent from the exact route metadata before creating an Agent', async () => {
    const h = harness({ modelSelection: { provider: 'top', model: 'top-model', reasoningEffort: 'xhigh' } })
    const result = await h.runner.run(JOB, FIRED_AT)
    expect(result.failure?.message).toContain('does not support reasoning effort "xhigh"')
    expect(h.calls).not.toContain('agent-create')
  })

  it('fails a fire with its job name when the configured route remains unknown', async () => {
    const h = harness({ modelSelection: { provider: 'missing', model: 'model' }, unresolvedModel: true })
    const result = await h.runner.run(JOB, FIRED_AT)
    expect(result.outcome).toBe('failed')
    expect(result.failure?.message).toContain(
      'dsh-cron: job "morning-brief" modelSelection: provider "missing" model "model" cannot be resolved',
    )
    expect(h.calls).not.toContain('agent-create')
  })

  it('hands over the notes with the prompt when the job carries them', async () => {
    const h = harness({ replyText: 'ok' })
    await h.runner.run({ ...JOB, notes: 'Second run.' }, FIRED_AT)
    expect(h.calls).toContain(`followup:${runPrompt({ ...JOB, notes: 'Second run.' })}`)
  })

  it('starts a session, hands over the prompt carrying its job name and fire time, and reports the answer', async () => {
    const h = harness({ replyText: 'Brief posted.' })
    const result = await h.runner.run(JOB, FIRED_AT)
    expect(result.outcome).toBe('answered')
    expect(result.text).toBe('Brief posted.')
    expect(result.sessionId).toContain('cron-morning-brief-')
    expect(h.calls).toEqual([
      'preset-resolve:beardy',
      'scope:beardy',
      'workspace:/workspace',
      'agent-create',
      'mount:beardy',
      'attach',
      'permission-set:danger-full-access',
      `title:morning-brief ${new Date(FIRED_AT).toISOString()}`,
      `followup:${runPrompt(JOB)}`,
    ])
    expect(h.runner.live()).toBe(1)
  })

  it('reports a run whose session could not be mounted', async () => {
    for (const failStart of ['workspace', 'attach'] as const) {
      const h = harness({ replyText: 'x', failStart })
      expect((await h.runner.run(JOB, FIRED_AT)).outcome).toBe('failed')
      expect(h.ctx.logger.error).toHaveBeenCalledWith(expect.stringContaining('could not start a session'))
    }
  })

  it('rolls back a session that fails after being attached', async () => {
    const h = harness({ replyText: 'x', failStart: 'title' })
    expect((await h.runner.run(JOB, FIRED_AT)).outcome).toBe('failed')
    expect(h.calls).toContain('detach')
    expect(h.handle.dispose).toHaveBeenCalledTimes(1)
  })

  it('reports a run that outlives its bound, cancelling and releasing its session', async () => {
    const h = harness({ hang: true, turnTimeoutMs: 5 })
    expect((await h.runner.run(JOB, FIRED_AT)).outcome).toBe('timed-out')
    expect(h.ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('did not settle within'))
    expect(h.handle.dispose).toHaveBeenCalledTimes(1)
    expect(h.runner.live()).toBe(0)
    h.releaseIdle()
  })

  it('reports a failed delay while the turn is pending as failed', async () => {
    const h = harness({ hang: true, rejectWait: true })
    expect((await h.runner.run(JOB, FIRED_AT)).outcome).toBe('failed')
    expect(h.handle.dispose).toHaveBeenCalledTimes(1)
    h.releaseIdle()
  })

  it('reports a turn that fails outright as failed', async () => {
    const h = harness({ replyText: 'late', rejectIdle: true })
    expect((await h.runner.run(JOB, FIRED_AT)).outcome).toBe('failed')
  })

  it('reports the logged error and discards text written before it', async () => {
    for (const replyText of ['', 'partial answer']) {
      const h = harness({ replyText, ending: { kind: 'error', error: { code: 'SERVER', message: 'provider unavailable' } } })
      expect(await h.runner.run(JOB, FIRED_AT)).toMatchObject({
        outcome: 'failed', text: '', failure: { code: 'SERVER', message: 'provider unavailable' },
      })
      expect(h.ctx.logger.error).toHaveBeenCalledWith(expect.stringContaining('run failed (SERVER)'))
    }
  })

  it('reports an aborted turn as interrupted', async () => {
    const h = harness({ replyText: 'partial answer', ending: { kind: 'aborted', reason: { kind: 'user' } } })
    expect(await h.runner.run(JOB, FIRED_AT)).toMatchObject({ outcome: 'interrupted', text: '' })
  })

  it('refuses to call an idle turn without a terminal event an answer', async () => {
    const h = harness({ replyText: 'partial', omitEnding: true })
    expect(await h.runner.run(JOB, FIRED_AT)).toMatchObject({
      outcome: 'failed', text: '', failure: { code: 'MISSING_TURN_END' },
    })
  })

  it('refuses a merge-extended terminal reason it does not recognize', async () => {
    const ending: TurnEndReason = { kind: 'completed' }
    Reflect.set(ending, 'kind', 'future-ending')
    const h = harness({ replyText: 'partial', ending })
    expect(await h.runner.run(JOB, FIRED_AT)).toMatchObject({
      outcome: 'failed', text: '', failure: { code: 'UNKNOWN_TURN_END' },
    })
  })

  it.each([
    [{ kind: 'blocked' } as const, 'BLOCKED'],
    [{ kind: 'max-tokens' } as const, 'MAX_TOKENS'],
  ])('reports %s as failed even after text', async (ending, code) => {
    const h = harness({ replyText: 'partial', ending })
    expect(await h.runner.run(JOB, FIRED_AT)).toMatchObject({ outcome: 'failed', text: '', failure: { code } })
  })

  it('uses the job timeout when set and the plugin timeout otherwise', async () => {
    const seen: number[] = []
    const h = harness({ replyText: 'done', turnTimeoutMs: 5_000,
      wait: (ms) => { seen.push(ms); return new Promise<void>(() => {}) } })
    expect((await h.runner.run({ ...JOB, turnTimeoutMs: 1_500 }, FIRED_AT)).outcome).toBe('answered')
    expect((await h.runner.run(JOB, FIRED_AT)).outcome).toBe('answered')
    expect(seen).toEqual([1_500, 5_000])
  })

  it('times out a pending run at its job-specific bound', async () => {
    const seen: number[] = []
    const h = harness({ hang: true, turnTimeoutMs: 5_000,
      wait: async (ms) => { seen.push(ms) } })
    expect((await h.runner.run({ ...JOB, turnTimeoutMs: 1_500 }, FIRED_AT)).outcome).toBe('timed-out')
    expect(seen).toEqual([1_500])
    expect(h.handle.dispose).toHaveBeenCalledTimes(1)
    h.releaseIdle()
  })

  it('cancels a waiting run when the scheduler is cancelled without an error reason', async () => {
    const h = harness({ hang: true, turnTimeoutMs: 5_000 })
    const running = h.runner.run(JOB, FIRED_AT)
    await vi.waitFor(() => { expect(h.calls.some(call => call.startsWith('followup:'))).toBe(true) })
    h.controller.abort('scheduler gone')
    expect((await running).outcome).toBe('interrupted')
    h.releaseIdle()
  })

  it('reports a run that ends without text', async () => {
    const h = harness({ replyText: '' })
    expect((await h.runner.run(JOB, FIRED_AT)).outcome).toBe('no-text-answer')
    expect(h.ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining('without a text answer'))
  })

  it('releases the oldest runs beyond the live cap', async () => {
    const h = harness({ replyText: 'ok' })
    await h.runner.run(JOB, FIRED_AT)
    await h.runner.run(JOB, FIRED_AT + 1_000)
    await h.runner.run(JOB, FIRED_AT + 2_000)
    expect(h.runner.live()).toBe(3)
    await h.runner.trim(2)
    expect(h.runner.live()).toBe(2)
    expect(h.handle.dispose).toHaveBeenCalledTimes(1)
    await h.runner.trim(5)
    expect(h.runner.live()).toBe(2)
  })

  it('trims completed runs without releasing another job still working', async () => {
    const active = harness({ hang: true })
    const finished = harness({ replyText: 'done' })
    active.ctx.agents.create = vi.fn()
      .mockResolvedValueOnce(active.handle)
      .mockResolvedValueOnce(finished.handle)
    const running = active.runner.run(JOB, FIRED_AT)
    await vi.waitFor(() => { expect(active.calls.some(call => call.startsWith('followup:'))).toBe(true) })
    await active.runner.run({ ...JOB, name: 'another' }, FIRED_AT)
    await active.runner.trim(0)
    expect(finished.handle.dispose).toHaveBeenCalledTimes(1)
    expect(active.handle.dispose).not.toHaveBeenCalled()
    active.releaseIdle()
    await running
    await active.runner.dispose()
  })

  it('disposes every mounted run and reports a failed teardown', async () => {
    const h = harness({ replyText: 'ok' })
    await h.runner.run(JOB, FIRED_AT)
    h.handle.dispose.mockRejectedValueOnce(new Error('dispose failed'))
    await h.runner.dispose()
    expect(h.runner.live()).toBe(0)
    expect(h.ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('disposal of session'))
  })

  it('does not dispose an active Session again when cancellation follows disposal', async () => {
    const h = harness({ hang: true })
    const running = h.runner.run(JOB, FIRED_AT)
    await vi.waitFor(() => { expect(h.calls.some(call => call.startsWith('followup:'))).toBe(true) })
    await h.runner.dispose()
    h.controller.abort(new Error('shutdown'))
    expect((await running).outcome).toBe('interrupted')
    expect(h.handle.dispose).toHaveBeenCalledTimes(1)
    h.releaseIdle()
  })

  it('refuses to mount a session for a cancelled scheduler', async () => {
    const h = harness({ replyText: 'ok' })
    h.controller.abort(new Error('scheduler disposed'))
    expect((await h.runner.run(JOB, FIRED_AT)).outcome).toBe('interrupted')
    expect(h.calls).not.toContain('preset-resolve:beardy')
    expect(h.calls).not.toContain('agent-create')
  })
})
