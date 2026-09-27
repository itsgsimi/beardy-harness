import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { jobStateRecord, storedJobRecord } from '../src/domain.ts'
import { isInsideRoot, nextFireGap } from '../src/registry.ts'
import { CONFIG_JOB, createInput, makeRegistry, reopenRegistry, storedRow } from './support.ts'

describe('isInsideRoot', () => {
  it.each([
    ['/srv', '/srv', true],
    ['/srv', '/srv/repo', true],
    ['/srv/', '/srv/repo', true],
    ['/srv', '/srvother', false],
    ['/srv/repo', '/srv', false],
    ['/', '/etc', true],
  ])('maps %s inside %s to %s', (root, path, expected) => {
    expect(isInsideRoot(root, path)).toBe(expected)
  })
})

describe('nextFireGap', () => {
  it('measures the gap between the next two fires', () => {
    const from = new Date(Date.UTC(2026, 8, 5, 12, 0, 0))
    expect(nextFireGap('0 * * * *', 'UTC', from)).toBe(3_600_000)
    expect(nextFireGap('0 7 * * *', 'Europe/Zagreb', from)).toBe(86_400_000)
  })

  it('reports Infinity when fewer than two fires remain in a bounded schedule', () => {
    const oneShot = '0 0 12 31 12 * 2027'
    expect(nextFireGap(oneShot, 'UTC', new Date(Date.UTC(2027, 11, 31, 11, 0)))).toBe(Number.POSITIVE_INFINITY)
    expect(nextFireGap(oneShot, 'UTC', new Date(Date.UTC(2999, 0, 1)))).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('job registry view', () => {
  it('merges configured and stored jobs sorted by name with continuity state', () => {
    const { registry } = makeRegistry([CONFIG_JOB], {
      stored: [storedRow('pr-check')],
      state: { 'pr-check': { notes: 'Round two.', lastRuns: [{ firedAt: 1, sessionId: SessionId('s'), outcome: 'answered' }] } },
    })
    const names = registry.list().map(job => job.name)
    expect(names).toEqual(['morning-brief', 'pr-check'])
    const stored = registry.list()[1]
    expect(stored).toMatchObject({ origin: 'stored', enabled: true, notes: 'Round two.' })
    expect(registry.list()[0]).toMatchObject({ origin: 'config', enabled: true, notes: '' })
  })

  it('carries configured and stored delivery channels into the view', () => {
    const { registry } = makeRegistry([CONFIG_JOB], {
      delivery: new Map([['morning-brief', 'chan-1']]),
      stored: [storedRow('pr-check', { deliver: { kind: 'channel', channelId: 'chan-2' } })],
    })
    expect(registry.find('morning-brief')?.deliverChannelId).toBe('chan-1')
    expect(registry.find('pr-check')?.deliverChannelId).toBe('chan-2')
  })

  it('keeps paused stored jobs out of the scheduled set', () => {
    const { registry } = makeRegistry([CONFIG_JOB], { stored: [storedRow('pr-check', { enabled: false })] })
    expect(registry.scheduled().map(job => job.name)).toEqual(['morning-brief'])
    expect(registry.find('pr-check')?.enabled).toBe(false)
  })

  it('refuses to build when a stored job collides with a configured name', () => {
    expect(() => makeRegistry([CONFIG_JOB], { stored: [storedRow(CONFIG_JOB.name)] }))
      .toThrow('job name "morning-brief" collides: configured and stored at once')
  })
})

describe('job registry create', () => {
  it('stores a new job armed, with creation metadata and no delivery', async () => {
    const { registry, jobsTable } = makeRegistry()
    const created = await registry.create(createInput())
    expect(created).toMatchObject({ name: 'pr-check', origin: 'stored', enabled: true })
    const record = jobsTable.rows.get('pr-check')
    expect(record?.deliver).toEqual({ kind: 'none' })
    expect(record?.createdAt).toBeGreaterThan(0)
  })

  it('stores a channel delivery target when the input names one', async () => {
    const { registry, jobsTable } = makeRegistry()
    await registry.create(createInput({ deliverChannelId: 'chan-9' }))
    expect(jobsTable.rows.get('pr-check')?.deliver).toEqual({ kind: 'channel', channelId: 'chan-9' })
  })

  it('stores an optional per-job timeout and rejects an invalid bound', async () => {
    const { registry, jobsTable } = makeRegistry()
    await expect(registry.create(createInput({ turnTimeoutMs: 999 }))).rejects.toThrow('turnTimeoutMs must be a safe integer')
    await registry.create(createInput({ turnTimeoutMs: 4_000 }))
    expect(jobsTable.rows.get('pr-check')?.turnTimeoutMs).toBe(4_000)
    expect(registry.find('pr-check')?.turnTimeoutMs).toBe(4_000)
    await expect(registry.update('pr-check', { turnTimeoutMs: 2.5 })).rejects.toThrow('turnTimeoutMs must be a safe integer')
    expect((await registry.update('pr-check', { turnTimeoutMs: 8_000 })).turnTimeoutMs).toBe(8_000)
  })

  it('accepts stored definitions and history written before optional fields existed', () => {
    expect(storedJobRecord.safeParse(storedRow('old')).success).toBe(true)
    expect(jobStateRecord.safeParse({ notes: '', lastRuns: [{ firedAt: 1, sessionId: 'old', outcome: 'failed' }] }).success).toBe(true)
    expect(jobStateRecord.safeParse({ notes: '', lastRuns: [{ firedAt: 2, sessionId: 'new', outcome: 'failed',
      failure: { code: 'SERVER', message: 'provider unavailable' } }] }).success).toBe(true)
    expect(storedJobRecord.safeParse(storedRow('bad', { turnTimeoutMs: 999 })).success).toBe(false)
  })

  it('refuses a name taken by a configured or existing stored job', async () => {
    const { registry } = makeRegistry([CONFIG_JOB])
    await expect(registry.create(createInput({ name: CONFIG_JOB.name }))).rejects.toThrow('taken by a configured job')
    await registry.create(createInput())
    await expect(registry.create(createInput())).rejects.toThrow('already exists; update it instead')
  })

  it('refuses presets outside the allowlists, naming what is allowed', async () => {
    const { registry } = makeRegistry()
    await expect(registry.create(createInput({ agentPreset: 'root-mode' }))).rejects.toThrow('agent preset "root-mode" is not allowed for stored jobs; allowed: [beardy]')
    await expect(registry.create(createInput({ permissionPreset: 'danger-full-access' }))).rejects.toThrow('permission preset "danger-full-access" is not allowed')
  })

  it('refuses a workspace outside every allowed root', async () => {
    const { registry } = makeRegistry()
    await expect(registry.create(createInput({ workspacePath: '/etc' }))).rejects.toThrow('workspace "/etc" is outside every allowedWorkspaceRoot: [/srv]')
    await expect(registry.create(createInput({ workspacePath: 'relative' }))).rejects.toThrow('workspace "relative" is outside every allowedWorkspaceRoot')
  })

  it('reports a workspace or allowed root that cannot be canonicalized', async () => {
    const missingWorkspace = makeRegistry([], {
      canonicalPath: async (path) => {
        if (path === '/srv/missing') throw new Error('missing workspace')
        return path
      },
    })
    await expect(missingWorkspace.registry.create(createInput({ workspacePath: '/srv/missing' })))
      .rejects.toThrow('workspace "/srv/missing" cannot be resolved: Error: missing workspace')
    const missingRoot = makeRegistry([], {
      canonicalPath: async (path) => {
        if (path === '/srv') throw new Error('missing root')
        return path
      },
    })
    await expect(missingRoot.registry.create(createInput())).rejects.toThrow('allowedWorkspaceRoot "/srv" cannot be resolved: Error: missing root')
  })

  it('refuses a run for a job removed before its workspace check', async () => {
    const { registry } = makeRegistry()
    await expect(registry.resolveRunWorkspace(createInput())).rejects.toThrow('no job named "pr-check"')
  })

  it('refuses a symlink inside an allowed root that resolves outside it on create and update', async () => {
    const base = await mkdtemp(join(process.cwd(), '.cron-root-test-'))
    try {
      const root = join(base, 'allowed')
      const outside = join(base, 'outside')
      await Promise.all([mkdir(root), mkdir(outside)])
      await symlink(outside, join(root, 'escape'), 'dir')
      const { registry } = makeRegistry([], {
        stored: [storedRow('existing', { workspacePath: root })],
        guardrails: { allowedWorkspaceRoots: [root] }, canonicalPath: realpath,
      })
      await expect(registry.create(createInput({ workspacePath: join(root, 'escape') })))
        .rejects.toThrow('outside every allowedWorkspaceRoot')
      await expect(registry.update('existing', { workspacePath: join(root, 'escape') }))
        .rejects.toThrow('outside every allowedWorkspaceRoot')
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('passes the canonical in-root workspace to a run and refuses a later symlink escape', async () => {
    const base = await mkdtemp(join(process.cwd(), '.cron-retarget-test-'))
    try {
      const root = join(base, 'allowed')
      const inside = join(root, 'inside')
      const outside = join(base, 'outside')
      const link = join(root, 'current')
      await Promise.all([mkdir(inside, { recursive: true }), mkdir(outside)])
      await symlink(inside, link, 'dir')
      const { registry } = makeRegistry([], {
        guardrails: { allowedWorkspaceRoots: [root] }, canonicalPath: realpath,
      })
      const job = await registry.create(createInput({ workspacePath: link }))
      expect(await registry.resolveRunWorkspace(job)).toBe(inside)
      await rm(link)
      await symlink(outside, link, 'dir')
      await expect(registry.resolveRunWorkspace(job)).rejects.toThrow('outside every allowedWorkspaceRoot')
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('refuses an unparseable schedule and one faster than minIntervalMs', async () => {
    const { registry } = makeRegistry()
    await expect(registry.create(createInput({ expression: 'every morning' }))).rejects.toThrow('is unusable')
    const brisk = makeRegistry([], { guardrails: { minIntervalMs: 120_000 } })
    await expect(brisk.registry.create(createInput({ expression: '* * * * *' })))
      .rejects.toThrow('fires more often than every 120000ms, below minIntervalMs')
  })

  it('refuses a create once the store is full', async () => {
    const { registry } = makeRegistry([], { guardrails: { maxStoredJobs: 1 } })
    await registry.create(createInput())
    await expect(registry.create(createInput({ name: 'second' }))).rejects.toThrow('already holds its 1 jobs; delete one first')
  })
})

describe('job registry update, pause, and delete', () => {
  it('patches stored fields and re-checks guardrails', async () => {
    const { registry, jobsTable } = makeRegistry([], { stored: [storedRow('pr-check')] })
    const updated = await registry.update('pr-check', { prompt: 'Check PRs twice.', expression: '0 9,17 * * 1' })
    expect(updated).toMatchObject({ prompt: 'Check PRs twice.', expression: '0 9,17 * * 1' })
    expect(jobsTable.rows.get('pr-check')?.prompt).toBe('Check PRs twice.')
    await expect(registry.update('pr-check', { workspacePath: '/etc' })).rejects.toThrow('outside every allowedWorkspaceRoot')
  })

  it('patches timezone, presets, and title together', async () => {
    const { registry } = makeRegistry([], { stored: [storedRow('pr-check')] })
    const updated = await registry.update('pr-check', {
      timezone: 'UTC', agentPreset: 'beardy', permissionPreset: 'workspace-write', title: 'Renamed',
    })
    expect(updated).toMatchObject({ timezone: 'UTC', title: 'Renamed' })
  })

  it('replaces and clears the delivery channel', async () => {
    const { registry } = makeRegistry([], { stored: [storedRow('pr-check')] })
    expect((await registry.update('pr-check', { deliverChannelId: 'chan-3' })).deliverChannelId).toBe('chan-3')
    expect((await registry.update('pr-check', { deliverChannelId: '' })).deliverChannelId).toBeUndefined()
  })

  it('refuses definition changes of a configured job, naming the action', async () => {
    const { registry } = makeRegistry([CONFIG_JOB])
    await expect(registry.update(CONFIG_JOB.name, { prompt: 'x' })).rejects.toThrow('comes from configuration; update applies to stored jobs only')
    await expect(registry.remove(CONFIG_JOB.name)).rejects.toThrow('delete applies to stored jobs only')
  })

  it('pauses and resumes a configured job through arm state, keeping its definition out of the store', async () => {
    const { registry, jobsTable, stateTable } = makeRegistry([CONFIG_JOB])
    expect((await registry.setEnabled(CONFIG_JOB.name, false)).enabled).toBe(false)
    expect(registry.scheduled().map(job => job.name)).toEqual([])
    expect(jobsTable.rows.has(CONFIG_JOB.name)).toBe(false)
    expect(stateTable.rows.get(CONFIG_JOB.name)?.enabled).toBe(false)
    expect((await registry.setEnabled(CONFIG_JOB.name, true)).enabled).toBe(true)
    expect(registry.scheduled().map(job => job.name)).toEqual(['morning-brief'])
  })

  it('carries a configured pause into a registry reopened over the same state', async () => {
    const opened = makeRegistry([CONFIG_JOB])
    await opened.registry.setEnabled(CONFIG_JOB.name, false)
    const reopened = reopenRegistry({ jobsTable: opened.jobsTable.rows, stateTable: opened.stateTable.rows }, [CONFIG_JOB])
    expect(reopened.find(CONFIG_JOB.name)?.enabled).toBe(false)
    expect(reopened.scheduled()).toEqual([])
  })

  it('refuses unknown names on mutation', async () => {
    const { registry } = makeRegistry()
    await expect(registry.setEnabled('ghost', true)).rejects.toThrow('no job named "ghost"')
    await expect(registry.remove('ghost')).rejects.toThrow('no job named "ghost"')
  })

  it('pauses and resumes a stored job, keeping its definition', async () => {
    const { registry, jobsTable } = makeRegistry([], { stored: [storedRow('pr-check')] })
    expect((await registry.setEnabled('pr-check', false)).enabled).toBe(false)
    expect(jobsTable.rows.get('pr-check')?.prompt).toBe('Check open pull requests.')
    expect((await registry.setEnabled('pr-check', true)).enabled).toBe(true)
  })

  it('reports a stored job removed during an arm-state write', async () => {
    const h = makeRegistry([], { stored: [storedRow('pr-check')] })
    const put = h.stateTable.put
    h.stateTable.put = async (name, value) => {
      await put(name, value)
      h.jobsTable.rows.delete(name)
    }
    await expect(h.registry.setEnabled('pr-check', false)).rejects.toThrow('disappeared while its arm state was being written')
  })

  it('deletes the definition together with its continuity state', async () => {
    const { registry, jobsTable, stateTable } = makeRegistry([], {
      stored: [storedRow('pr-check')],
      state: { 'pr-check': { notes: 'keep me?', lastRuns: [] } },
    })
    await registry.remove('pr-check')
    expect(jobsTable.rows.has('pr-check')).toBe(false)
    expect(stateTable.rows.has('pr-check')).toBe(false)
  })
})

describe('job registry continuity state', () => {
  it('keeps concurrent notes and run history when the first write waits for durability', async () => {
    const { registry, stateTable } = makeRegistry([CONFIG_JOB])
    await registry.beginRun(CONFIG_JOB.name, { firedAt: 1, sessionId: SessionId('s'), reportOutcome: true })
    const blocked = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    const put = stateTable.put
    stateTable.put = async (name, value) => {
      entered.resolve(undefined)
      await blocked.promise
      await put(name, value)
    }
    const note = registry.setNotes(CONFIG_JOB.name, 'Do not repeat this item.')
    await entered.promise
    const record = registry.settleRun(CONFIG_JOB.name, { sessionId: SessionId('s'), outcome: 'answered', text: 'done' }, 3)
    blocked.resolve(undefined)
    await Promise.all([note, record])
    expect(registry.find(CONFIG_JOB.name)).toMatchObject({ notes: 'Do not repeat this item.', lastRuns: [{ sessionId: SessionId('s') }] })
  })

  it('reserves a run and retains its output until the matching acknowledgement', async () => {
    const { registry, stateTable } = makeRegistry([CONFIG_JOB])
    await registry.beginRun(CONFIG_JOB.name, { firedAt: 1, sessionId: SessionId('s'), reportOutcome: true, deliverChannelId: 'c' })
    expect(stateTable.rows.get(CONFIG_JOB.name)?.activeRun?.sessionId).toBe('s')
    await registry.setNotes(CONFIG_JOB.name, 'Second fire.')
    const payload = await registry.settleRun(CONFIG_JOB.name, { sessionId: SessionId('s'), outcome: 'answered', text: 'Result' }, 0)
    expect(payload).toMatchObject({ jobName: CONFIG_JOB.name, text: 'Result', deliverChannelId: 'c' })
    expect(stateTable.rows.get(CONFIG_JOB.name)).toMatchObject({ notes: 'Second fire.', lastRuns: [], pendingOutcome: { text: 'Result' } })
    expect(stateTable.rows.get(CONFIG_JOB.name)?.activeRun).toBeUndefined()
    await registry.acknowledgeOutcome(CONFIG_JOB.name, 'other')
    expect(registry.pendingOutcome(CONFIG_JOB.name)).toEqual(payload)
    await registry.acknowledgeOutcome(CONFIG_JOB.name, 's')
    expect(registry.pendingOutcome(CONFIG_JOB.name)).toBeUndefined()
  })

  it('recovers interrupted work and finished undelivered output without duplicating history', async () => {
    const active = { firedAt: 2, sessionId: SessionId('active'), reportOutcome: true, deliverChannelId: 'c' }
    const { registry, stateTable } = makeRegistry([CONFIG_JOB], { state: {
      [CONFIG_JOB.name]: { notes: 'Remember this.', lastRuns: [], activeRun: active },
      'notes-only': { notes: 'Saved notes.', lastRuns: [] },
      removed: { notes: '', lastRuns: [{ firedAt: 1, sessionId: SessionId('done'), outcome: 'answered' }], pendingOutcome: {
        firedAt: 1, sessionId: SessionId('done'), outcome: 'answered', text: 'Saved result', reportOutcome: true,
      } },
    } })
    const recovered = await registry.recoverRuns(3)
    expect(recovered).toEqual(expect.arrayContaining([
      { jobName: CONFIG_JOB.name, ...active, outcome: 'interrupted', text: '' },
      expect.objectContaining({ jobName: 'removed', text: 'Saved result' }),
    ]))
    expect(await registry.recoverRuns(3)).toEqual(recovered)
    expect(stateTable.rows.get(CONFIG_JOB.name)?.lastRuns).toHaveLength(1)
    expect(stateTable.rows.get(CONFIG_JOB.name)?.lastRuns[0]?.durationMs).toBeUndefined()
    expect(stateTable.rows.get('removed')?.lastRuns).toHaveLength(1)
  })

  it('refuses deletion and a second start while work or delivery is pending', async () => {
    const { registry } = makeRegistry([], { stored: [storedRow('pr-check')] })
    const run = { firedAt: 1, sessionId: SessionId('s'), reportOutcome: true }
    await registry.beginRun('pr-check', run)
    await expect(registry.beginRun('pr-check', run)).rejects.toThrow('unfinished run or delivery')
    await expect(registry.remove('pr-check')).rejects.toThrow('pause it and wait')
    await registry.settleRun('pr-check', { sessionId: SessionId('s'), outcome: 'failed', text: '' }, 3)
    await expect(registry.beginRun('pr-check', run)).rejects.toThrow('unfinished run or delivery')
    await registry.acknowledgeOutcome('pr-check', 's')
    await registry.remove('pr-check')
    await expect(registry.beginRun('pr-check', run)).rejects.toThrow('not armed')
    await expect(registry.settleRun('pr-check', { sessionId: SessionId('s'), outcome: 'failed', text: '' }, 3)).rejects.toThrow('no active run')
  })

  it('leaves a failed outcome write recoverable as an active attempt', async () => {
    const { registry, stateTable } = makeRegistry([CONFIG_JOB])
    await registry.beginRun(CONFIG_JOB.name, { firedAt: 1, sessionId: SessionId('s'), reportOutcome: true })
    const original = stateTable.put
    stateTable.put = vi.fn(async () => { throw new Error('disk full') })
    await expect(registry.settleRun(CONFIG_JOB.name, { sessionId: SessionId('s'), outcome: 'answered', text: 'done' }, 3)).rejects.toThrow('disk full')
    expect(stateTable.rows.get(CONFIG_JOB.name)?.activeRun?.sessionId).toBe('s')
    stateTable.put = original
    expect(await registry.recoverRuns(3)).toEqual([expect.objectContaining({ outcome: 'interrupted' })])
  })

  it('takes notes for configured and stored jobs alike', async () => {
    const { registry, stateTable } = makeRegistry([CONFIG_JOB], { stored: [storedRow('pr-check')] })
    await registry.setNotes(CONFIG_JOB.name, 'Weather source flaky.')
    await registry.setNotes('pr-check', 'Waiting on PR 42.')
    expect(stateTable.rows.get('morning-brief')?.notes).toBe('Weather source flaky.')
    expect(stateTable.rows.get('pr-check')?.notes).toBe('Waiting on PR 42.')
  })

  it('refuses notes for an unknown job or past the cap', async () => {
    const { registry } = makeRegistry()
    await expect(registry.setNotes('ghost', 'x')).rejects.toThrow('no job named "ghost" to take notes')
    await expect(registry.create(createInput())).resolves.toBeDefined()
    await expect(registry.setNotes('pr-check', 'x'.repeat(401)))
      .rejects.toThrow('above the cap of 400; condense the continuity notes and retry')
  })

  it('prepends run history newest-first, bounded by the keep count', async () => {
    const { registry, stateTable } = makeRegistry([], { stored: [storedRow('pr-check')] })
    for (const [firedAt, sessionId, outcome] of [[1, 'a', 'answered'], [2, 'b', 'timed-out'], [3, 'c', 'failed']] as const) {
      await registry.beginRun('pr-check', { firedAt, sessionId: SessionId(sessionId), reportOutcome: true })
      await registry.settleRun('pr-check', { sessionId, outcome, text: '' }, 2)
      await registry.acknowledgeOutcome('pr-check', sessionId)
    }
    const runs = stateTable.rows.get('pr-check')?.lastRuns
    expect(runs?.map(({ durationMs: _duration, ...rest }) => rest)).toEqual([
      { firedAt: 3, sessionId: SessionId('c'), outcome: 'failed' },
      { firedAt: 2, sessionId: SessionId('b'), outcome: 'timed-out' },
    ])
    expect(runs?.every(run => typeof run.durationMs === 'number' && run.durationMs >= 0)).toBe(true)
  })

  it('retains failure code and message in history and pending delivery across reopen', async () => {
    const h = makeRegistry([CONFIG_JOB])
    await h.registry.beginRun(CONFIG_JOB.name, { firedAt: 1, sessionId: SessionId('s'), reportOutcome: true })
    const failure = { code: 'SERVER', message: 'provider unavailable' }
    await h.registry.settleRun(CONFIG_JOB.name, { sessionId: SessionId('s'), outcome: 'failed', text: '', failure }, 3)
    const reopened = reopenRegistry({ jobsTable: h.jobsTable.rows, stateTable: h.stateTable.rows }, [CONFIG_JOB])
    expect(reopened.find(CONFIG_JOB.name)?.lastRuns[0]?.failure).toEqual(failure)
    expect(reopened.pendingOutcome(CONFIG_JOB.name)?.failure).toEqual(failure)
  })

  it('keeps notes while recording runs and survives a zero keep count', async () => {
    const { registry, stateTable } = makeRegistry([CONFIG_JOB])
    await expect(registry.setNotes('ghost-notes', 'x')).rejects.toThrow('no job named')
    await registry.setNotes(CONFIG_JOB.name, 'Keep this.')
    await registry.beginRun(CONFIG_JOB.name, { firedAt: 1, sessionId: SessionId('a'), reportOutcome: true })
    await registry.settleRun(CONFIG_JOB.name, { sessionId: SessionId('a'), outcome: 'answered', text: '' }, 0)
    expect(stateTable.rows.get(CONFIG_JOB.name)).toMatchObject({ notes: 'Keep this.', lastRuns: [] })
  })
})
