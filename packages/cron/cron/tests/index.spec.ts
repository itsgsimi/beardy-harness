import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, assertConfig, createSchedulerHost, mountJobs } from '../src/index.ts'
import type { CronJobSpec, ResolvedConfig } from '../src/index.ts'
import type { Scheduler } from '../src/schedule.ts'

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
    ...overrides,
  }
}

describe('assertConfig', () => {
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

  it.each<[string, Partial<ResolvedConfig>]>([
    ['turnTimeoutMs', { turnTimeoutMs: 1.5 }],
    ['maxLiveRuns', { maxLiveRuns: 0 }],
  ])('rejects a non-positive %s', (field, overrides) => {
    expect(() => { assertConfig(config(overrides)) })
      .toThrow(`${field} must be a positive safe integer`)
  })
})

/** Scheduler seam that hands the test the fire callbacks per job and counts stops. */
function fakeScheduler() {
  const ticks = new Map<string, (firedAt: number) => void>()
  let stopped = 0
  let next: number | undefined = Date.parse('2026-09-05T05:00:00.000Z')
  const scheduler: Scheduler = (job, onTick) => {
    ticks.set(job.expression, onTick)
    return {
      stop: () => { stopped += 1 },
      nextRunAt: () => next,
    }
  }
  return {
    scheduler,
    fire: (expression = '0 7 * * *') => { ticks.get(expression)?.(Date.parse('2026-09-04T05:00:00.000Z')) },
    tickCount: () => ticks.size,
    stoppedCount: () => stopped,
    withoutNextRun: () => { next = undefined },
  }
}

/** In-memory KvTable stand-in over a plain map. */
function fakeTable<T>(backing = new Map<string, T>()) {
  return {
    rows: backing,
    get: (key: string) => backing.get(key),
    entries: () => backing.entries(),
    keys: () => backing.keys(),
    size: backing.size,
    put: async (key: string, value: T) => { backing.set(key, value) },
    delete: async (key: string) => backing.delete(key),
    update: async (key: string, fn: (current: T) => T) => {
      const next = fn(backing.get(key) as T)
      backing.set(key, next)
      return next
    },
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
    },
    whenIdle: async () => {},
  }
  const handle = { agent, dispose: vi.fn(async () => {}) }
  const disposers: (() => Promise<void> | void)[] = []
  const tables = new Map<string, ReturnType<typeof fakeTable>>()
  const emitted: { event: string; payload: unknown }[] = []
  const tools: { name: string }[] = []
  const commands: { name: string; handler?: unknown }[] = []
  const listeners: { event: string; handler: (payload: never) => void }[] = []
  let domainClosed = false
  const ctx = {
    logger,
    emit: (event: string, payload: unknown) => { emitted.push({ event, payload }) },
    on: (event: string, handler: (payload: never) => void) => {
      listeners.push({ event, handler })
      return () => {}
    },
    tools: { register: (tool: { name: string }) => { tools.push(tool); return () => {} } },
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
    agentPresets: { resolve: async (id: string) => ({ id }), standingKeyFor: async () => ({}), mount: async () => {} },
    workspaceRegistry: {
      create: async (path: string) => ({ path, attachSession: async () => {}, detachSession: async () => {} }),
    },
    agents: { create: async () => handle },
    sessionTitle: { rename: () => {} },
  }
  const emitTo = (event: string, payload: unknown): void => {
    for (const listener of listeners) if (listener.event === event) listener.handler(payload as never)
  }
  return {
    ctx: { ...ctx, ...overrides } as unknown as Context,
    logger, handle, disposers, emitted, tools, commands, tables, emitTo,
    domainClosed: () => domainClosed,
  }
}

describe('mountJobs', () => {
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
})

describe('apply', () => {
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

  it('leaves timers alone for changes in other tables or domains', async () => {
    const { ctx, emitTo } = contextStub()
    const fake = fakeScheduler()
    await apply(ctx, config(), fake.scheduler)
    emitTo('domain/changed', { domain: 'cron_jobs', table: 'state', key: 'morning-brief', operation: 'put' })
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
