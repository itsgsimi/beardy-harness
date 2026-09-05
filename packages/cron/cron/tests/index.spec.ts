import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, assertConfig, mountJobs } from '../src/index.ts'
import type { CronJobConfig, ResolvedConfig } from '../src/index.ts'
import type { Scheduler } from '../src/schedule.ts'

const JOB: CronJobConfig = {
  name: 'morning-brief',
  expression: '0 7 * * *',
  timezone: 'Europe/Zagreb',
  prompt: 'Summarize the feeds.',
  agentPreset: 'beardy',
  permissionPreset: 'danger-full-access',
  workspacePath: '/workspace',
}

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return { jobs: [JOB], turnTimeoutMs: 600_000, maxLiveRuns: 20, ...overrides }
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

/** Scheduler seam that hands the test the fire callback and counts stops. */
function fakeScheduler() {
  let callback: ((firedAt: number) => void) | undefined
  let stopped = 0
  let next: number | undefined = Date.parse('2026-09-05T05:00:00.000Z')
  const scheduler: Scheduler = (_job, onTick) => {
    callback = onTick
    return {
      stop: () => { stopped += 1 },
      nextRunAt: () => next,
    }
  }
  return {
    scheduler,
    fire: () => { callback?.(Date.parse('2026-09-04T05:00:00.000Z')) },
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
    },
    whenIdle: async () => {},
  }
  const handle = { agent, dispose: vi.fn(async () => {}) }
  const disposers: (() => Promise<void> | void)[] = []
  const ctx = {
    logger,
    effect: vi.fn((setup: () => (() => Promise<void>) | undefined) => { disposers.push(setup()) }),
    permissionPresets: { resolve: () => ({}), set: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    agentPresets: { resolve: async (id: string) => ({ id }), mount: async () => {} },
    workspaceRegistry: {
      create: async (path: string) => ({ path, attachSession: async () => {}, detachSession: async () => {} }),
    },
    agents: { create: async () => handle },
    sessionTitle: { rename: () => {} },
  }
  return { ctx: { ...ctx, ...overrides } as unknown as Context, logger, handle, disposers }
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

describe('apply', () => {
  it('mounts without scheduling anything when no jobs are configured', () => {
    const { ctx, logger } = contextStub()
    apply(ctx, config({ jobs: [] }))
    expect(logger.info).toHaveBeenCalledWith('dsh-cron: mounted with no jobs')
    expect(ctx.effect).not.toHaveBeenCalled()
  })

  it('registers a disposer that stops every scheduled job', async () => {
    const { ctx, disposers } = contextStub()
    apply(ctx, config())
    expect(ctx.effect).toHaveBeenCalledTimes(1)
    for (const dispose of disposers) await dispose?.()
  })

  it('refuses an unusable job list before scheduling anything', () => {
    const { ctx } = contextStub()
    expect(() => { apply(ctx, config({ jobs: [{ ...JOB, workspacePath: 'relative' }] })) })
      .toThrow('needs an absolute workspacePath')
  })
})
