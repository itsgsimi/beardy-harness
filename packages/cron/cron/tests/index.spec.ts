import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply, assertConfig, Config, createSchedulerHost, mountJobs } from '../src/index.ts'
import type { CronJobSpec, CronRunFinished, CronRunResult, ResolvedConfig } from '../src/index.ts'
import type { Scheduler } from '../src/schedule.ts'
import { fakeTable } from './support.ts'
import type { JobStateRecord } from '../src/domain.ts'
import type { createCronManageTool } from '../src/tool.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
  vi.useRealTimers()
})

const JOB: CronJobSpec = {
  name: 'morning-brief',
  expression: '0 7 * * *',
  timezone: 'Europe/Zagreb',
  prompt: 'Summarize the feeds.',
  agentPreset: 'beardy',
  permissionPreset: 'danger-full-access',
  workspacePath: '/workspace',
}

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    jobs: [JOB],
    turnTimeoutMs: 600_000,
    maxLiveRuns: 20,
    allowedAgentPresets: ['beardy'],
    allowedPermissionPresets: ['workspace-write'],
    allowedWorkspaceRoots: ['/srv'],
    maxStoredJobs: 5,
    minIntervalMs: 60_000,
    notesMaxChars: 400,
    keepRunHistory: 3,
    requireApproval: false,
    deliverOutcomes: true,
    deliveryRetryMs: 30_000,
    ...overrides,
  }
}

describe('assertConfig', () => {
  it('parses a top-level choice and a configured job override', () => {
    const parsed = Config(config({ jobs: [{ ...JOB, modelSelection: {
      provider: 'job', model: 'model', reasoningEffort: 'medium',
    } }], modelSelection: { provider: 'top', model: 'model', reasoningEffort: 'medium' } }))
    expect(parsed.modelSelection).toEqual({ provider: 'top', model: 'model', reasoningEffort: 'medium' })
    expect(parsed.jobs[0]?.modelSelection).toEqual({ provider: 'job', model: 'model', reasoningEffort: 'medium' })
  })

  it('mounts a cron-wide choice before an adapter is registered', async () => {
    const { ctx, tables } = contextStub({ llm: { resolveModelInfo: async () => ({
      provider: 'local', id: 'coder', name: 'Coder', reasoning: { efforts: [] },
    }) } })
    await expect(apply(ctx, config({ modelSelection: {
      provider: 'local', model: 'coder', reasoningEffort: 'medium',
    } }), fakeScheduler().scheduler)).resolves.toBeUndefined()
    expect(tables.size).toBeGreaterThan(0)
  })

  it('mounts job overrides before an adapter is registered', async () => {
    const { ctx, tables } = contextStub({ llm: { resolveModelInfo: async () => ({
      provider: 'local', id: 'coder', name: 'Coder', reasoning: { efforts: [] },
    }) } })
    await expect(apply(ctx, config({ jobs: [{ ...JOB, modelSelection: {
      provider: 'local', model: 'coder', reasoningEffort: 'medium',
    } }] }), fakeScheduler().scheduler)).resolves.toBeUndefined()
    expect(tables.size).toBeGreaterThan(0)
  })

  it('mounts a supported cron-wide selection', async () => {
    const resolveModelInfo = vi.fn(async () => ({
      provider: 'local', id: 'coder', name: 'Coder', reasoning: { efforts: [{ id: 'medium', name: 'Medium' }] },
    }))
    const { ctx, tools } = contextStub({ llm: { resolveModelInfo } })
    await apply(ctx, config({ modelSelection: {
      provider: 'local', model: 'coder', reasoningEffort: 'medium',
    } }), fakeScheduler().scheduler)
    expect(resolveModelInfo).not.toHaveBeenCalled()
    expect(tools).toHaveLength(1)
  })

  it('accepts a job list that can run', () => {
    expect(() => { assertConfig(config()) }).not.toThrow()
    expect(() => { assertConfig(config({ jobs: [] })) }).not.toThrow()
  })

  it('rejects two jobs sharing one name', () => {
    expect(() => { assertConfig(config({ jobs: [JOB, { ...JOB }] })) })
      .toThrow('job names must be unique, "morning-brief" appears twice')
  })

  it('names the job whose expression cannot be parsed', () => {
    expect(() => { assertConfig(config({ jobs: [{ ...JOB, expression: 'not a schedule' }] })) })
      .toThrow('job "morning-brief" has an unusable schedule')
  })

  it('rejects a job whose workspace is relative', () => {
    expect(() => { assertConfig(config({ jobs: [{ ...JOB, workspacePath: 'workspace' }] })) })
      .toThrow('needs an absolute workspacePath, got "workspace"')
  })

  it('rejects an invalid configured per-job timeout', () => {
    expect(() => { assertConfig(config({ jobs: [{ ...JOB, turnTimeoutMs: 999 }] })) })
      .toThrow('job "morning-brief" turnTimeoutMs must be a safe integer of at least 1000 milliseconds')
  })

  it.each<[string, Partial<ResolvedConfig>]>([
    ['turnTimeoutMs', { turnTimeoutMs: 1.5 }],
    ['maxLiveRuns', { maxLiveRuns: 0 }],
    ['notesMaxChars', { notesMaxChars: 0 }],
  ])('rejects a non-positive %s', (field, overrides) => {
    expect(() => { assertConfig(config(overrides)) })
      .toThrow(`${field} must be a positive safe integer`)
  })
})

/** Scheduler seam that hands the test the fire callbacks per job and counts live timers and stops. */
function fakeScheduler() {
  const ticks = new Map<string, (firedAt: number) => void>()
  let stopped = 0
  // `sync` stops every timer before starting a fresh set, so creations minus stops is the live set.
  let started = 0
  let next: number | undefined = Date.parse('2026-09-05T05:00:00.000Z')
  const scheduler: Scheduler = (job, onTick) => {
    started += 1
    ticks.set(job.expression, onTick)
    return {
      stop: () => { stopped += 1 },
      nextRunAt: () => next,
    }
  }
  return {
    scheduler,
    fire: (expression = '0 7 * * *', firedAt = Date.parse('2026-09-04T05:00:00.000Z')) => {
      ticks.get(expression)?.(firedAt)
    },
    tickCount: () => started - stopped,
    stoppedCount: () => stopped,
    withoutNextRun: () => { next = undefined },
  }
}

/** Context whose created agent answers immediately; `overrides` replaces whole services. */
function contextStub(overrides: Record<string, unknown> = {}) {
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
  const events: Record<string, unknown>[] = []
  const agent = {
    session: { get seq(): number { return events.length }, ownEvents: () => events },
    followup: () => {
      events.push({ seq: events.length + 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } })
      events.push({ seq: events.length + 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    },
    whenIdle: async () => {},
  }
  const handle = { agent, dispose: vi.fn(async () => {}) }
  const disposers: (() => Promise<void> | void)[] = []
  const tables = new Map<string, ReturnType<typeof fakeTable>>()
  const emitted: { event: string; payload: unknown }[] = []
  const tools: ReturnType<typeof createCronManageTool>[] = []
  const commands: { name: string; handler?: unknown }[] = []
  const listeners: { event: string; handler: (payload: never) => void }[] = []
  let domainClosed = false
  cleanup.push(async () => { for (const dispose of disposers.splice(0)) await dispose() })
  const ctx = {
    logger,
    emit: (event: string, payload: unknown) => { emitted.push({ event, payload }) },
    serial: async (event: string, payload: unknown) => { emitted.push({ event, payload }); return true },
    on: (event: string, handler: (payload: never) => void) => {
      listeners.push({ event, handler })
      return () => {}
    },
    tools: { register: (tool: ReturnType<typeof createCronManageTool>) => { tools.push(tool); return () => {} } },
    commands: { register: (command: { name: string; handler?: unknown }) => { commands.push(command); return () => {} } },
    storageDomain: {
      open: async () => ({
        table: (name: string) => {
          let table = tables.get(name)
          if (table === undefined) { table = fakeTable(); tables.set(name, table) }
          return table
        },
        close: async () => { domainClosed = true },
      }),
    },
    effect: vi.fn((setup: () => (() => Promise<void>) | undefined) => {
      const dispose = setup()
      if (dispose !== undefined) disposers.push(dispose)
    }),
    permissionPresets: { resolve: () => ({}), set: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    agentPresets: {
      resolve: async (id: string) => ({ id }),
      acquireScope: async () => ({ key: {}, [Symbol.asyncDispose]: async () => {} }),
      mount: async () => {},
    },
    workspaceRegistry: {
      create: async (path: string) => ({ path, attachSession: async () => {}, detachSession: async () => {} }),
    },
    agents: { create: async () => handle },
    sessionTitle: { rename: () => {} },
  }
  const emitTo = (event: string, payload: unknown): void => {
    for (const listener of listeners) if (listener.event === event) listener.handler(payload as never)
  }
  const testContext = new Context().extend({ ...ctx, ...overrides })
  if (overrides.llm !== undefined) testContext.provide('llm', overrides.llm as never)
  return {
    ctx: testContext,
    logger, handle, disposers, emitted, tools, commands, tables, emitTo,
    domainClosed: () => domainClosed,
  }
}

describe('mountJobs', () => {
  it('mounts a cron-wide selection without changing the default service', async () => {
    const { ctx } = contextStub({ llm: { resolveModelInfo: async () => ({
      provider: 'local', id: 'coder', name: 'Coder', reasoning: { efforts: [{ id: 'medium', name: 'Medium' }] },
    }) } })
    const created = vi.spyOn(ctx.agents, 'create')
    const fake = fakeScheduler()
    const mounted = mountJobs(ctx, config({ modelSelection: {
      provider: 'local', model: 'coder', reasoningEffort: 'medium',
    } }), fake.scheduler)
    fake.fire()
    await expect.poll(() => created.mock.calls.length).toBe(1)
    expect(created).toHaveBeenCalledWith(expect.objectContaining({
      agentOptions: { provider: 'local', model: 'coder', reasoningEffort: 'medium' },
    }))
    expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'p', model: 'm' })
    await mounted.dispose()
  })

  it('schedules every job and logs its next run', async () => {
    const { ctx, logger } = contextStub()
    const fake = fakeScheduler()
    const mounted = mountJobs(ctx, config(), fake.scheduler)
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('scheduled "morning-brief" (0 7 * * * Europe/Zagreb), next run 2026-09-05T05:00:00.000Z'))
    await mounted.dispose()
    expect(fake.stoppedCount()).toBe(1)
  })

  it('omits the next-run note when the schedule reports none', async () => {
    const { ctx, logger } = contextStub()
    const fake = fakeScheduler()
    fake.withoutNextRun()
    const mounted = mountJobs(ctx, config(), fake.scheduler)
    expect(logger.info).toHaveBeenCalledWith('dsh-cron: scheduled "morning-brief" (0 7 * * * Europe/Zagreb)')
    await mounted.dispose()
  })

  it('runs the job when its schedule fires', async () => {
    const { ctx, logger } = contextStub()
    const fake = fakeScheduler()
    const mounted = mountJobs(ctx, config(), fake.scheduler)
    fake.fire()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('finished in session cron-morning-brief-'))
    expect(mounted.runner.live()).toBe(1)
    await mounted.dispose()
  })

  it('skips a fire while the previous run of the same job is still going', async () => {
    let resolveIdle: () => void = () => {}
    const events: Record<string, unknown>[] = []
    const { ctx, logger } = contextStub({
      agents: {
        create: async () => ({
          agent: {
            session: { get seq(): number { return events.length }, ownEvents: () => events },
            followup: () => {},
            whenIdle: () => new Promise<void>((resolve) => { resolveIdle = resolve }),
          },
          dispose: async () => {},
        }),
      },
    })
    const fake = fakeScheduler()
    const mounted = mountJobs(ctx, config({ turnTimeoutMs: 60_000 }), fake.scheduler)
    fake.fire()
    await new Promise(resolve => setTimeout(resolve, 5))
    fake.fire()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('this fire is skipped'))
    resolveIdle()
    await new Promise(resolve => setTimeout(resolve, 5))
    fake.fire()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(logger.warn).toHaveBeenCalledTimes(1)
    await mounted.dispose()
  })

  it('opens a fresh session for the fire after a timed-out run', async () => {
    let creates = 0
    const { ctx, logger } = contextStub({
      agents: {
        create: async () => {
          creates += 1
          return {
            agent: {
              session: { seq: 0, ownEvents: () => [] },
              followup: () => {},
              whenIdle: () => new Promise<void>(() => {}),
            },
            dispose: vi.fn(async () => {}),
          }
        },
      },
    })
    const fake = fakeScheduler()
    const mounted = mountJobs(ctx, config({ turnTimeoutMs: 5 }), fake.scheduler)
    fake.fire()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('did not settle within'))
    expect(mounted.runner.live()).toBe(0)
    fake.fire()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(creates).toBe(2)
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('this fire is skipped'))
    await mounted.dispose()
  })

  it('reports a run that throws after its session was mounted', async () => {
    const { ctx, logger } = contextStub({
      agents: {
        create: async () => ({
          agent: {
            session: { seq: 0, ownEvents: () => [] },
            followup: () => { throw new Error('inbox rejected the prompt') },
            whenIdle: async () => {},
          },
          dispose: async () => {},
        }),
      },
    })
    const fake = fakeScheduler()
    const mounted = mountJobs(ctx, config(), fake.scheduler)
    fake.fire()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('run reported a failure'))
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('inbox rejected the prompt'))
    await mounted.dispose()
  })

  it('releases runs beyond the configured live cap', async () => {
    const { ctx } = contextStub()
    const fake = fakeScheduler()
    const mounted = mountJobs(ctx, config({ maxLiveRuns: 1 }), fake.scheduler)
    for (const offset of [0, 1, 2]) {
      fake.fire()
      await new Promise(resolve => setTimeout(resolve, 2 ** offset))
    }
    expect(mounted.runner.live()).toBeLessThanOrEqual(1)
    await mounted.dispose()
  })
})

/** A stored job row as the durable table holds it. */
function storedRow(name: string, expression: string): Record<string, unknown> {
  return {
    name, expression, timezone: 'Europe/Zagreb', prompt: 'Check PRs.',
    agentPreset: 'beardy', permissionPreset: 'workspace-write', workspacePath: '/srv/x',
    enabled: true, deliver: { kind: 'none' }, createdAt: 1,
  }
}

const settle = (ms = 10): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('createSchedulerHost', () => {
  it('records a local-model skip before opening an Agent Session', async () => {
    const { ctx } = contextStub()
    ctx.provide('localModels', {
      unloadedForRoute: provider => provider === 'p' ? { backend: 'ornith',
        intent: { by: 'Goran', at: '2026-09-27T18:00:00.000Z' } } : undefined,
      unloadedForHealthUrl: () => undefined,
      backends: () => [],
    })
    const created = vi.spyOn(ctx.agents, 'create')
    const skipped: CronRunResult[] = []
    const host = createSchedulerHost(ctx, { turnTimeoutMs: 60_000, maxLiveRuns: 5,
      onSkipped: (_job, _firedAt, result) => { skipped.push(result) } }, fakeScheduler().scheduler)
    host.sync([{ ...JOB, notes: '' }])
    host.trigger(JOB.name)
    await vi.waitFor(() => { expect(skipped).toHaveLength(1) })
    expect(skipped[0]?.failure?.code).toBe('LOCAL_MODEL_UNLOADED')
    expect(skipped[0]?.failure?.message).toContain('ornith')
    expect(created).not.toHaveBeenCalled()
    await host.dispose()
  })

  it('ignores callbacks from replaced or stopped timers and cancels a queued fire', async () => {
    const { ctx } = contextStub()
    const create = vi.spyOn(ctx.agents, 'create')
    const fake = fakeScheduler()
    const host = createSchedulerHost(ctx, { turnTimeoutMs: 60_000, maxLiveRuns: 5 }, fake.scheduler)
    host.sync([{ ...JOB, notes: '' }])
    host.sync([])
    fake.fire()
    host.sync([{ ...JOB, notes: '' }])
    fake.fire()
    await host.dispose()
    fake.fire()
    expect(create).not.toHaveBeenCalled()
  })

  it('waits for settlement before disposing and refuses triggers afterward', async () => {
    const { ctx } = contextStub()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const host = createSchedulerHost(ctx, {
      turnTimeoutMs: 60_000, maxLiveRuns: 5,
      onSettled: async () => { entered.resolve(undefined); await release.promise },
    }, fakeScheduler().scheduler)
    host.sync([{ ...JOB, notes: '' }])
    host.trigger(JOB.name)
    await entered.promise
    let disposed = false
    const closing = host.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    expect(host.trigger(JOB.name)).toBe(false)
    host.sync([{ ...JOB, notes: '' }])
    expect(host.trigger(JOB.name)).toBe(false)
    release.resolve(undefined)
    await closing
  })

  it('fires the next job match while disposal of an older job is stalled', async () => {
    const disposalEntered = Promise.withResolvers<undefined>()
    const releaseDisposal = Promise.withResolvers<undefined>()
    const settled: string[] = []
    let created = 0
    const { ctx } = contextStub({ agents: { create: async () => {
      const index = created++
      const events = [
        { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } },
        { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      ]
      return {
        agent: {
          session: { seq: 0, ownEvents: () => events }, followup: () => {}, whenIdle: async () => {},
        },
        dispose: async () => { if (index === 0) { disposalEntered.resolve(undefined); await releaseDisposal.promise } },
      }
    } } })
    const fake = fakeScheduler()
    const host = createSchedulerHost(ctx, {
      turnTimeoutMs: 60_000, maxLiveRuns: 1,
      onSettled: (job) => { settled.push(job.name) },
    }, fake.scheduler)
    host.sync([{ ...JOB, notes: '' }, { ...JOB, name: 'second', expression: '5 7 * * *', notes: '' }])
    try {
      fake.fire()
      await vi.waitFor(() => { expect(settled).toEqual([JOB.name]) })
      fake.fire('5 7 * * *')
      await disposalEntered.promise
      fake.fire('5 7 * * *')
      await vi.waitFor(() => { expect(settled).toEqual([JOB.name, 'second', 'second']) })
    } finally {
      releaseDisposal.resolve(undefined)
      await host.dispose()
    }
  })

  it('fires an armed job on trigger and ignores names that are not armed', async () => {
    const { ctx, logger } = contextStub()
    const fake = fakeScheduler()
    const host = createSchedulerHost(ctx, { turnTimeoutMs: 60_000, maxLiveRuns: 5 }, fake.scheduler)
    expect(host.trigger('morning-brief')).toBe(false)
    host.sync([{ ...JOB, notes: '' }])
    expect(host.trigger('morning-brief')).toBe(true)
    await settle()
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('finished in session cron-morning-brief-'))
    await host.dispose()
  })

  it('re-arms timers on sync while the runner keeps mounted runs', async () => {
    const { ctx } = contextStub()
    const fake = fakeScheduler()
    const host = createSchedulerHost(ctx, { turnTimeoutMs: 60_000, maxLiveRuns: 5 }, fake.scheduler)
    host.sync([{ ...JOB, notes: '' }])
    fake.fire()
    await settle()
    expect(host.runner.live()).toBe(1)
    host.sync([])
    expect(fake.stoppedCount()).toBe(1)
    expect(host.trigger('morning-brief')).toBe(false)
    await host.dispose()
  })

  it('logs an overlapping fire whose skip cannot be recorded and lets the running fire finish', async () => {
    const { ctx, logger } = contextStub()
    const settled = Promise.withResolvers<CronRunResult>()
    const host = createSchedulerHost(ctx, {
      turnTimeoutMs: 60_000, maxLiveRuns: 5,
      onSkipped: async () => { throw new Error('state table unavailable') },
      onSettled: (_job, _firedAt, result) => { settled.resolve(result) },
    }, fakeScheduler().scheduler)
    host.sync([{ ...JOB, notes: '' }])
    expect(host.trigger(JOB.name)).toBe(true)
    expect(host.trigger(JOB.name)).toBe(false)
    expect(await settled.promise).toMatchObject({ outcome: 'answered', text: 'done' })
    await host.dispose()
    expect(logger.warn).toHaveBeenCalledWith('dsh-cron: job "morning-brief" is still running; this fire is skipped')
    expect(logger.error).toHaveBeenCalledWith(
      'dsh-cron: job "morning-brief" skipped fire could not be recorded: state table unavailable',
    )
  })

  it('logs a failed release of completed Sessions without blocking the next fire', async () => {
    const { ctx, logger } = contextStub()
    const outcomes: string[] = []
    const secondSettled = Promise.withResolvers<undefined>()
    const host = createSchedulerHost(ctx, {
      turnTimeoutMs: 60_000, maxLiveRuns: 0,
      onSettled: (_job, _firedAt, result) => {
        outcomes.push(result.outcome)
        if (outcomes.length === 2) secondSettled.resolve(undefined)
      },
    }, fakeScheduler().scheduler)
    const releasing = Promise.withResolvers<undefined>()
    vi.spyOn(host.runner, 'trim').mockImplementationOnce(async () => {
      releasing.resolve(undefined)
      throw new Error('release bookkeeping failed')
    })
    host.sync([{ ...JOB, notes: '' }])
    expect(host.trigger(JOB.name)).toBe(true)
    await releasing.promise
    expect(host.trigger(JOB.name)).toBe(true)
    await secondSettled.promise
    await host.dispose()
    expect(outcomes).toEqual(['answered', 'answered'])
    expect(logger.error).toHaveBeenCalledWith('dsh-cron: releasing completed sessions failed: release bookkeeping failed')
  })
})

describe('apply', () => {
  it('persists an intentional local-model skip with its reason and no Agent Session', async () => {
    const { ctx, tables, emitted } = contextStub()
    const create = vi.spyOn(ctx.agents, 'create')
    ctx.provide('localModels', {
      unloadedForRoute: provider => provider === 'p' ? { backend: 'ornith',
        intent: { by: 'Goran', at: '2026-09-27T18:00:00.000Z' } } : undefined,
      unloadedForHealthUrl: () => undefined,
      backends: () => [],
    })
    const fake = fakeScheduler()
    await apply(ctx, config(), fake.scheduler)
    fake.fire()
    await vi.waitFor(() => {
      const state = tables.get('state')?.rows.get(JOB.name) as JobStateRecord | undefined
      expect(state?.lastRuns[0]).toMatchObject({ outcome: 'skipped', failure: { code: 'LOCAL_MODEL_UNLOADED' } })
      expect(state?.lastRuns[0]?.failure?.message).toContain('unloaded by Goran')
    })
    expect(create).not.toHaveBeenCalled()
    expect(emitted.find(item => item.event === 'cron/run-finished')).toMatchObject({
      payload: { jobName: JOB.name, outcome: 'skipped' },
    })
  })

  it('records and delivers an overlapping scheduled fire as skipped', async () => {
    const releaseIdle = Promise.withResolvers<undefined>()
    const { ctx, tables, emitted } = contextStub({ agents: { create: async () => ({
      agent: {
        session: { seq: 0, ownEvents: () => [] }, followup: () => {},
        whenIdle: () => releaseIdle.promise,
      },
      dispose: async () => {},
    }) } })
    const fake = fakeScheduler()
    await apply(ctx, config({ jobs: [{ ...JOB, deliverChannel: 'c' }] }), fake.scheduler)
    try {
      fake.fire()
      await vi.waitFor(() => {
        expect(tables.get('state')?.rows.get(JOB.name)).toHaveProperty('activeRun')
      })
      fake.fire()
      await vi.waitFor(() => {
        const state = tables.get('state')?.rows.get(JOB.name) as JobStateRecord | undefined
        expect(state?.lastRuns[0]).toMatchObject({
          outcome: 'skipped', failure: { code: 'PREVIOUS_RUN_IN_PROGRESS' },
        })
      })
      expect(emitted.find(item => item.event === 'cron/run-finished' && (item.payload as CronRunFinished).outcome === 'skipped'))
        .toMatchObject({ payload: { jobName: JOB.name, reportOutcome: true, deliverChannelId: 'c' } })
    } finally {
      releaseIdle.resolve(undefined)
    }
  })

  it('records a delivery-blocked fire after its preceding run settled', async () => {
    vi.useFakeTimers()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<true>()
    const handoffs: CronRunFinished[] = []
    const serial = vi.fn(async (_event: string, payload: CronRunFinished) => {
      handoffs.push(payload)
      entered.resolve(undefined)
      return await release.promise
    })
    const h = contextStub({ serial })
    const create = vi.spyOn(h.ctx.agents, 'create')
    const fake = fakeScheduler()
    await apply(h.ctx, config({ jobs: [{ ...JOB, deliverChannel: 'c' }], turnTimeoutMs: 1_000 }), fake.scheduler)
    try {
      fake.fire()
      await entered.promise
      await vi.advanceTimersByTimeAsync(0)
      fake.fire('0 7 * * *', Date.parse('2026-09-05T05:00:00.000Z'))
      await vi.advanceTimersByTimeAsync(1_000)
      const state = h.tables.get('state')?.rows.get(JOB.name) as JobStateRecord | undefined
      expect(state?.lastRuns[0]).toMatchObject({
        outcome: 'skipped', failure: { code: 'PREVIOUS_OUTCOME_PENDING' },
      })
      expect(create).toHaveBeenCalledTimes(1)
      expect(handoffs.some(payload => payload.outcome === 'skipped')).toBe(true)
    } finally {
      release.resolve(true)
      await vi.advanceTimersByTimeAsync(0)
    }
  })

  it('records a failed fire when a stored workspace symlink is retargeted outside its root', async () => {
    const base = await mkdtemp(join(process.cwd(), '.cron-fire-test-'))
    const root = join(base, 'allowed')
    const inside = join(root, 'inside')
    const outside = join(base, 'outside')
    const link = join(root, 'current')
    const h = contextStub()
    cleanup.push(async () => { await rm(base, { recursive: true, force: true }) })
    await Promise.all([mkdir(inside, { recursive: true }), mkdir(outside)])
    await symlink(inside, link, 'dir')
    const createAgent = vi.spyOn(h.ctx.agents, 'create')
    const scheduler = fakeScheduler()
    await apply(h.ctx, config({ jobs: [], allowedWorkspaceRoots: [root] }), scheduler.scheduler)
    const tool = h.tools.find(item => item.name === 'cron_manage')
    if (tool === undefined) throw new Error('cron_manage tool was not registered')
    await tool.execute({
      action: 'create', name: 'retargeted', expression: '0 9 * * 1', timezone: 'Europe/Zagreb',
      prompt: 'Check PRs.', agent_preset: 'beardy', permission_preset: 'workspace-write', workspace_path: link,
    }, { callId: 'create', signal: new AbortController().signal } as never)
    h.emitTo('domain/changed', { domain: 'cron_jobs', table: 'jobs' })
    await rm(link)
    await symlink(outside, link, 'dir')
    scheduler.fire('0 9 * * 1')
    await vi.waitFor(() => {
      const state = h.tables.get('state')?.rows.get('retargeted') as JobStateRecord | undefined
      expect(state?.lastRuns[0]).toMatchObject({
        outcome: 'failed', failure: { code: 'WORKSPACE_OUTSIDE_ALLOWED_ROOTS' },
      })
      expect(state?.lastRuns[0]?.failure?.message).toContain('outside every allowedWorkspaceRoot')
    })
    expect(createAgent).not.toHaveBeenCalled()
    const delivered = h.emitted.find(item => item.event === 'cron/run-finished')?.payload as CronRunFinished | undefined
    expect(delivered).toMatchObject({
      jobName: 'retargeted', outcome: 'failed', failure: { code: 'WORKSPACE_OUTSIDE_ALLOWED_ROOTS' },
    })
  })
  it('skips a job paused after its timer callback was queued', async () => {
    const { ctx, tables } = contextStub()
    const create = vi.spyOn(ctx.agents, 'create')
    const jobs = fakeTable()
    tables.set('jobs', jobs)
    jobs.rows.set('pr-check', storedRow('pr-check', '0 9 * * 1'))
    const fake = fakeScheduler()
    await apply(ctx, config({ jobs: [] }), fake.scheduler)
    fake.fire('0 9 * * 1')
    jobs.rows.set('pr-check', { ...storedRow('pr-check', '0 9 * * 1'), enabled: false })
    await Promise.resolve()
    await Promise.resolve()
    expect(create).not.toHaveBeenCalled()
  })

  it('shares a pending handoff across retry ticks', async () => {
    vi.useFakeTimers()
    const entered = Promise.withResolvers<undefined>()
    const accepted = Promise.withResolvers<true>()
    const serial = vi.fn(async () => { entered.resolve(undefined); return await accepted.promise })
    const { ctx, tables } = contextStub({ serial })
    const fake = fakeScheduler()
    await apply(ctx, config({ jobs: [{ ...JOB, deliverChannel: 'c' }] }), fake.scheduler)
    fake.fire()
    await entered.promise
    await vi.advanceTimersByTimeAsync(60_000)
    expect(serial).toHaveBeenCalledTimes(1)
    accepted.resolve(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(tables.get('state')?.rows.get(JOB.name)).not.toHaveProperty('pendingOutcome')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(serial).toHaveBeenCalledTimes(1)
  })

  it('hands off retained output before starting the next scheduled run', async () => {
    const serial = vi.fn(async () => undefined as true | undefined)
    const { ctx, logger, tables } = contextStub({ serial })
    const fake = fakeScheduler()
    await apply(ctx, config({ jobs: [{ ...JOB, deliverChannel: 'c' }] }), fake.scheduler)
    fake.fire()
    await vi.waitFor(() => { expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('no delivery listener')) })
    serial.mockResolvedValue(true)
    fake.fire()
    await vi.waitFor(() => { expect(serial).toHaveBeenCalledTimes(3) })
    expect(tables.get('state')?.rows.get(JOB.name)).toMatchObject({ lastRuns: [{ outcome: 'answered' }, { outcome: 'answered' }] })
  })

  it('finishes an ongoing startup handoff before disposal and leaves later outcomes pending', async () => {
    const entered = Promise.withResolvers<undefined>()
    const accepted = Promise.withResolvers<true>()
    const serial = vi.fn(async () => { entered.resolve(undefined); return await accepted.promise })
    const { ctx, tables, disposers, domainClosed, tools } = contextStub({ serial })
    const state = fakeTable()
    tables.set('state', state)
    for (const name of ['first', 'second']) {
      state.rows.set(name, { notes: '', lastRuns: [], pendingOutcome: {
        firedAt: 1, sessionId: name, outcome: 'answered', text: name, deliverChannelId: 'c', reportOutcome: true,
      } })
    }
    const loading = apply(ctx, config(), fakeScheduler().scheduler)
    await entered.promise
    const closing = Promise.all(disposers.splice(0).map(async (dispose) => { await dispose() }))
    expect(domainClosed()).toBe(false)
    accepted.resolve(true)
    await Promise.all([loading, closing])
    expect(domainClosed()).toBe(true)
    expect(serial).toHaveBeenCalledTimes(1)
    expect(state.rows.get('second')).toHaveProperty('pendingOutcome')
    expect(tools).toEqual([])
  })

  it('resolves newly saved notes at each fire without re-arming the timer', async () => {
    const prompts: string[] = []
    const { ctx, tables, emitted } = contextStub({ agents: {
      create: async () => ({
        agent: {
          session: { seq: 0, ownEvents: () => [] },
          followup: (message: { content: { text: string }[] }) => { prompts.push(message.content[0]!.text) },
          whenIdle: async () => {},
        },
        dispose: async () => {},
      }),
    } })
    const fake = fakeScheduler()
    await apply(ctx, config(), fake.scheduler)
    fake.fire()
    await vi.waitFor(() => { expect(emitted).toHaveLength(1) })
    const state = tables.get('state')!
    await state.put(JOB.name, { ...(state.rows.get(JOB.name) as object), notes: 'Already reported A.' })
    fake.fire()
    await vi.waitFor(() => { expect(prompts).toHaveLength(2) })
    expect(prompts[1]).toContain('Already reported A.')
    expect(fake.stoppedCount()).toBe(0)
  })

  it('persists the reservation before creating an Agent and history before delivering output', async () => {
    const { ctx, tables, emitted } = contextStub()
    const create = ctx.agents.create.bind(ctx.agents)
    ctx.agents.create = vi.fn(async (options: Parameters<typeof ctx.agents.create>[0]) => {
      expect(tables.get('state')?.rows.get(JOB.name)).toMatchObject({ activeRun: { sessionId: options.sessionId } })
      return await create(options)
    })
    ctx.serial = vi.fn(async (_event, payload) => {
      expect(tables.get('state')?.rows.get(JOB.name)).toMatchObject({
        lastRuns: [{ outcome: 'answered' }], pendingOutcome: { text: 'done' },
      })
      emitted.push({ event: 'cron/run-finished', payload })
      return true
    }) as typeof ctx.serial
    const fake = fakeScheduler()
    await apply(ctx, config(), fake.scheduler)
    fake.fire()
    await vi.waitFor(() => { expect(emitted).toHaveLength(1) })
    expect(tables.get('state')?.rows.get(JOB.name)).not.toHaveProperty('activeRun')
    await vi.waitFor(() => { expect(tables.get('state')?.rows.get(JOB.name)).not.toHaveProperty('pendingOutcome') })
  })

  it('starts no Agent when its reservation cannot be persisted', async () => {
    const { ctx, tables, logger } = contextStub()
    const create = vi.spyOn(ctx.agents, 'create')
    const fake = fakeScheduler()
    await apply(ctx, config(), fake.scheduler)
    tables.get('state')!.put = async () => { throw new Error('disk full') }
    fake.fire()
    await vi.waitFor(() => { expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('disk full')) })
    expect(create).not.toHaveBeenCalled()
  })

  it('retries recovered output after a delivery listener becomes available without running the Agent', async () => {
    vi.useFakeTimers()
    const serial = vi.fn(async () => undefined as true | undefined)
    const { ctx, tables } = contextStub({ serial })
    const create = vi.spyOn(ctx.agents, 'create')
    const state = fakeTable()
    tables.set('state', state)
    state.rows.set('removed-job', { notes: '', lastRuns: [{ firedAt: 1, sessionId: 'saved', outcome: 'answered' }], pendingOutcome: {
      firedAt: 1, sessionId: 'saved', outcome: 'answered', text: 'Saved answer', deliverChannelId: 'c', reportOutcome: true,
    } })
    await apply(ctx, config(), fakeScheduler().scheduler)
    expect(serial).toHaveBeenCalledTimes(1)
    expect(state.rows.get('removed-job')).toHaveProperty('pendingOutcome')
    serial.mockResolvedValue(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(serial).toHaveBeenCalledTimes(2)
    expect(state.rows.get('removed-job')).not.toHaveProperty('pendingOutcome')
    expect(create).not.toHaveBeenCalled()
  })

  it('records shutdown as interrupted before closing the durable domain', async () => {
    const admitted = Promise.withResolvers<undefined>()
    const { ctx, disposers, tables, domainClosed } = contextStub({ agents: {
      create: async () => ({
        agent: {
          session: { seq: 0, ownEvents: () => [] },
          followup: () => { admitted.resolve(undefined) },
          whenIdle: () => new Promise<void>(() => {}),
        },
        dispose: async () => {},
      }),
    } })
    const fake = fakeScheduler()
    await apply(ctx, config(), fake.scheduler)
    fake.fire()
    await admitted.promise
    for (const dispose of disposers.splice(0)) await dispose()
    expect(domainClosed()).toBe(true)
    expect(tables.get('state')?.rows.get(JOB.name)).toMatchObject({ lastRuns: [{ outcome: 'interrupted' }] })
    expect(tables.get('state')?.rows.get(JOB.name)).not.toHaveProperty('activeRun')
  })

  it('mounts management surfaces even when no jobs are configured', async () => {
    const { ctx, logger, tools, commands } = contextStub()
    await apply(ctx, config({ jobs: [] }), fakeScheduler().scheduler)
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('no configured jobs'))
    expect(tools.map(tool => tool.name)).toEqual(['cron_manage'])
    expect(commands.map(command => command.name)).toEqual(['cron'])
  })

  it('schedules configured jobs and records settled runs with an event', async () => {
    const { ctx, logger, emitted, tables } = contextStub()
    const fake = fakeScheduler()
    await apply(ctx, config(), fake.scheduler)
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('scheduled "morning-brief"'))
    fake.fire()
    await settle()
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      event: 'cron/run-finished',
      payload: { jobName: 'morning-brief', outcome: 'answered', text: 'done', reportOutcome: true },
    })
    const state = tables.get('state')?.rows.get('morning-brief') as { lastRuns: unknown[] } | undefined
    expect(state?.lastRuns).toHaveLength(1)
  })

  it('carries the configured delivery channel into the finished-run event', async () => {
    const { ctx, emitted } = contextStub()
    const fake = fakeScheduler()
    await apply(ctx, config({ jobs: [{ ...JOB, deliverChannel: 'channel-9' }] }), fake.scheduler)
    fake.fire()
    await settle()
    expect(emitted[0]?.payload).toMatchObject({ deliverChannelId: 'channel-9' })
  })

  it('re-plans timers when a stored job lands in the domain', async () => {
    const { ctx, tables, emitTo } = contextStub()
    const fake = fakeScheduler()
    await apply(ctx, config(), fake.scheduler)
    expect(fake.tickCount()).toBe(1)
    tables.get('jobs')?.rows.set('pr-check', storedRow('pr-check', '0 9 * * 1'))
    emitTo('domain/changed', { domain: 'cron_jobs', table: 'jobs', key: 'pr-check', operation: 'put' })
    expect(fake.tickCount()).toBe(2)
  })

  it('drops a configured job timer when its pause lands in the state table', async () => {
    const { ctx, tables, emitTo } = contextStub()
    const fake = fakeScheduler()
    await apply(ctx, config(), fake.scheduler)
    expect(fake.tickCount()).toBe(1)
    tables.get('state')?.rows.set('morning-brief', { notes: '', lastRuns: [], enabled: false })
    emitTo('domain/changed', { domain: 'cron_jobs', table: 'state', key: 'morning-brief', operation: 'put' })
    expect(fake.tickCount()).toBe(0)
  })

  it('leaves timers alone for changes in other domains', async () => {
    const { ctx, emitTo } = contextStub()
    const fake = fakeScheduler()
    await apply(ctx, config(), fake.scheduler)
    emitTo('domain/changed', { domain: 'discord-gateway', table: 'conversations', key: 'c', operation: 'put' })
    expect(fake.tickCount()).toBe(1)
  })

  it('registers a disposer that stops every scheduled job and closes the domain', async () => {
    const { ctx, disposers, domainClosed } = contextStub()
    const fake = fakeScheduler()
    await apply(ctx, config(), fake.scheduler)
    expect(ctx.effect).toHaveBeenCalledTimes(1)
    for (const dispose of disposers) await dispose?.()
    expect(fake.stoppedCount()).toBe(1)
    expect(domainClosed()).toBe(true)
  })

  it('runs an armed configured job through the registered /cron command', async () => {
    const { ctx, logger, commands } = contextStub()
    await apply(ctx, config(), fakeScheduler().scheduler)
    const handler = commands[0]?.handler as (invocation: { rawInput: string }) => Promise<{ kind: string }>
    expect((await handler({ rawInput: 'run morning-brief' })).kind).toBe('success')
    await settle()
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('finished in session cron-morning-brief-'))
  })

  it('refuses an unusable job list before scheduling anything', async () => {
    const { ctx } = contextStub()
    await expect(apply(ctx, config({ jobs: [{ ...JOB, workspacePath: 'relative' }] })))
      .rejects.toThrow('needs an absolute workspacePath')
  })

  it('refuses a relative allowed workspace root', async () => {
    const { ctx } = contextStub()
    await expect(apply(ctx, config({ allowedWorkspaceRoots: ['srv'] })))
      .rejects.toThrow('allowedWorkspaceRoots entries must be absolute')
  })
})
