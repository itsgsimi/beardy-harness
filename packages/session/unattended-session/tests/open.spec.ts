import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { openUnattendedSession } from '../src/open.ts'
import type { UnattendedSessionSpec } from '../src/open.ts'

type FailStep =
  | 'permission-resolve' | 'preset-resolve' | 'standing' | 'workspace'
  | 'agent' | 'attach' | 'permission-set' | 'title'

interface HarnessOptions {
  readonly failAt?: FailStep
  readonly failDetach?: boolean
  readonly failDispose?: boolean
  readonly abortAt?: 'workspace' | 'agent'
}

/** Context fake recording every step the open transaction takes, failing where asked. */
function harness(options: HarnessOptions = {}) {
  const calls: string[] = []
  const agent = { id: 's1', followup: () => {} }
  const handle = {
    agent: { ...agent, session: { id: 's1' } },
    dispose: vi.fn(async () => {
      calls.push('dispose')
      if (options.failDispose) throw new Error('dispose failed')
    }),
  }
  const workspace = {
    path: '/workspace',
    attachSession: async () => {
      calls.push('attach')
      if (options.failAt === 'attach') throw new Error('attach failed')
    },
    detachSession: async () => {
      calls.push('detach')
      if (options.failDetach) throw new Error('detach failed')
    },
  }
  const ctx = {
    logger: { warn: vi.fn() },
    permissionPresets: {
      resolve: (name: string) => {
        calls.push(`permission-resolve:${name}`)
        if (options.failAt === 'permission-resolve') throw new Error('permission resolve failed')
        return {}
      },
      set: (_session: unknown, name: string) => {
        calls.push(`permission-set:${name}`)
        if (options.failAt === 'permission-set') throw new Error('permission set failed')
      },
    },
    agentPresets: {
      resolve: async (name: string) => {
        calls.push(`preset-resolve:${name}`)
        if (options.failAt === 'preset-resolve') throw new Error('preset resolve failed')
        return { id: name }
      },
      standingKeyFor: async (name: string) => {
        calls.push(`standing:${name}`)
        if (options.failAt === 'standing') throw new Error('standing failed')
        return {}
      },
      mount: async (_agentCtx: unknown, name: string) => { calls.push(`mount:${name}`) },
    },
    workspaceRegistry: {
      create: async (path: string) => {
        calls.push(`workspace:${path}`)
        if (options.failAt === 'workspace') throw new Error('workspace failed')
        if (options.abortAt === 'workspace') controller.abort(new Error('abort after workspace'))
        return workspace
      },
    },
    agents: {
      create: async (createOptions: { setup?: (agentCtx: unknown) => Promise<unknown> }) => {
        calls.push('agent-create')
        if (options.failAt === 'agent') throw new Error('agent failed')
        const result = await createOptions.setup?.({ on: () => () => {} })
        if (result !== undefined) calls.push('setup-commit')
        if (options.abortAt === 'agent') controller.abort(new Error('abort after agent'))
        return handle
      },
    },
    sessionTitle: {
      rename: (_session: unknown, title: string) => {
        calls.push(`title:${title}`)
        if (options.failAt === 'title') throw new Error('title failed')
      },
    },
  }
  const controller = new AbortController()
  return { ctx: ctx as unknown as Context, calls, handle, workspace, controller }
}

const SPEC: UnattendedSessionSpec = {
  sessionId: SessionId('cron-brief-1'),
  agentPreset: 'standard',
  permissionPreset: 'read-only',
  workspacePath: '/workspace',
  title: 'Brief',
  agentOptions: { provider: 'p', model: 'm' },
}

describe('openUnattendedSession', () => {
  it('resolves, mounts, attaches, configures, and titles in order', async () => {
    const h = harness()
    const session = await openUnattendedSession(h.ctx, SPEC, h.controller.signal)
    expect(h.calls).toEqual([
      'permission-resolve:read-only',
      'preset-resolve:standard',
      'standing:standard',
      'workspace:/workspace',
      'agent-create',
      'mount:standard',
      'attach',
      'permission-set:read-only',
      'title:Brief',
    ])
    expect(session.sessionId).toBe(SPEC.sessionId)
    expect(session.handle).toBeDefined()
    expect(session.workspace.path).toBe('/workspace')
  })

  it('composes the caller setup after the preset mount and forwards its commit', async () => {
    const h = harness()
    await openUnattendedSession(h.ctx, {
      ...SPEC,
      setup: () => ({ commit: () => {} }),
    }, h.controller.signal)
    expect(h.calls).toEqual(expect.arrayContaining(['mount:standard', 'setup-commit']))
    expect(h.calls.indexOf('mount:standard')).toBeLessThan(h.calls.indexOf('setup-commit'))
  })

  it.each([
    'permission-resolve', 'preset-resolve', 'standing', 'workspace', 'agent', 'attach',
  ] as const)('contains a %s failure before the attach completes', async (failAt) => {
    const h = harness({ failAt })
    await expect(openUnattendedSession(h.ctx, SPEC, h.controller.signal)).rejects.toThrow()
    if (failAt === 'attach') expect(h.calls).toContain('dispose')
    expect(h.calls).not.toContain('detach')
  })

  it.each(['permission-set', 'title'] as const)('detaches and disposes after a %s failure', async (failAt) => {
    const h = harness({ failAt })
    await expect(openUnattendedSession(h.ctx, SPEC, h.controller.signal)).rejects.toThrow()
    expect(h.calls).toContain('detach')
    expect(h.calls).toContain('dispose')
  })

  it('preserves the original failure while reporting rollback failures', async () => {
    const h = harness({ failAt: 'title', failDetach: true, failDispose: true })
    await expect(openUnattendedSession(h.ctx, SPEC, h.controller.signal)).rejects.toThrow('title failed')
    expect(h.ctx.logger.warn).toHaveBeenCalledTimes(2)
  })

  it.each(['workspace', 'agent'] as const)('honors cancellation after %s settlement', async (abortAt) => {
    const h = harness({ abortAt })
    await expect(openUnattendedSession(h.ctx, SPEC, h.controller.signal)).rejects.toThrow(/abort after/)
    if (abortAt === 'agent') expect(h.calls).toContain('dispose')
  })
})
