import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createJobRunner, runTitle } from '../src/launch.ts'
import type { CronJobSpec } from '../src/types.ts'

const FIRED_AT = Date.parse('2026-09-04T05:00:00.000Z')

const JOB: CronJobSpec = {
  name: 'morning-brief',
  expression: '0 7 * * *',
  timezone: 'Europe/Zagreb',
  prompt: 'Summarize the feeds and today’s weather.',
  agentPreset: 'beardy',
  permissionPreset: 'danger-full-access',
  workspacePath: '/workspace',
}

interface HarnessOptions {
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
}

/** Context carrying only what a scheduled run touches, recording each step. */
function harness(options: HarnessOptions = {}) {
  const calls: string[] = []
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
          seq: events.length + 1,
          type: 'assistant/message',
          data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: options.replyText }] } },
        } as unknown as SessionEvent)
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
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    agentPresets: {
      resolve: async (name: string) => {
        calls.push(`preset-resolve:${name}`)
        return { id: name }
      },
      standingKeyFor: async (name: string) => { calls.push(`standing:${name}`); return {} },
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
      create: async (createOptions: { setup?: (agentCtx: unknown) => Promise<void> }) => {
        calls.push('agent-create')
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
  const runner = createJobRunner({
    ctx: ctx as unknown as Context,
    signal: controller.signal,
    turnTimeoutMs: options.turnTimeoutMs ?? 1_000,
    ...(options.rejectWait === true ? { wait: () => Promise.reject(new Error('scheduler gone')) } : {}),
  })
  return {
    runner, calls, events, handle, controller, ctx: ctx as unknown as Context,
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

describe('job runner', () => {
  it('starts a session, hands over the prompt with cron provenance, and reports the answer', async () => {
    const h = harness({ replyText: 'Brief posted.' })
    const outcome = await h.runner.run(JOB, FIRED_AT)
    expect(outcome).toBe('answered')
    expect(h.calls).toEqual([
      'preset-resolve:beardy',
      'standing:beardy',
      'workspace:/workspace',
      'agent-create',
      'mount:beardy',
      'attach',
      'permission-set:danger-full-access',
      `title:morning-brief ${new Date(FIRED_AT).toISOString()}`,
      'followup:Summarize the feeds and today’s weather.',
    ])
    expect(h.runner.live()).toBe(1)
  })

  it('reports a run whose session could not be mounted', async () => {
    for (const failStart of ['workspace', 'attach'] as const) {
      const h = harness({ replyText: 'x', failStart })
      expect(await h.runner.run(JOB, FIRED_AT)).toBe('failed')
      expect(h.ctx.logger.error).toHaveBeenCalledWith(expect.stringContaining('could not start a session'))
    }
  })

  it('rolls back a session that fails after being attached', async () => {
    const h = harness({ replyText: 'x', failStart: 'title' })
    expect(await h.runner.run(JOB, FIRED_AT)).toBe('failed')
    expect(h.calls).toContain('detach')
    expect(h.handle.dispose).toHaveBeenCalledTimes(1)
  })

  it('reports a run that outlives its bound, cancelling and releasing its session', async () => {
    const h = harness({ hang: true, turnTimeoutMs: 5 })
    expect(await h.runner.run(JOB, FIRED_AT)).toBe('timed-out')
    expect(h.ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('did not settle within'))
    expect(h.handle.dispose).toHaveBeenCalledTimes(1)
    expect(h.runner.live()).toBe(0)
    h.releaseIdle()
  })

  it('reports a bound whose delay seam rejected as a timeout', async () => {
    const h = harness({ replyText: 'late', rejectWait: true })
    expect(await h.runner.run(JOB, FIRED_AT)).toBe('timed-out')
  })

  it('reports a turn that fails outright as a timeout', async () => {
    const h = harness({ replyText: 'late', rejectIdle: true })
    expect(await h.runner.run(JOB, FIRED_AT)).toBe('timed-out')
  })

  it('cancels a waiting run when the scheduler is cancelled without an error reason', async () => {
    const h = harness({ hang: true, turnTimeoutMs: 5_000 })
    const running = h.runner.run(JOB, FIRED_AT)
    await new Promise(resolve => setTimeout(resolve, 2))
    h.controller.abort('scheduler gone')
    expect(await running).toBe('timed-out')
    h.releaseIdle()
  })

  it('reports a run that ends without text', async () => {
    const h = harness({ replyText: '' })
    expect(await h.runner.run(JOB, FIRED_AT)).toBe('no-text-answer')
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

  it('disposes every mounted run and reports a failed teardown', async () => {
    const h = harness({ replyText: 'ok' })
    await h.runner.run(JOB, FIRED_AT)
    h.handle.dispose.mockRejectedValueOnce(new Error('dispose failed'))
    await h.runner.dispose()
    expect(h.runner.live()).toBe(0)
    expect(h.ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('disposal of session'))
  })

  it('refuses to mount a session for a cancelled scheduler', async () => {
    const h = harness({ replyText: 'ok' })
    h.controller.abort(new Error('scheduler disposed'))
    expect(await h.runner.run(JOB, FIRED_AT)).toBe('failed')
    expect(h.calls).toContain('preset-resolve:beardy')
    expect(h.calls).not.toContain('agent-create')
  })
})
