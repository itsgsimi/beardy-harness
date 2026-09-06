import { describe, expect, it } from 'vitest'
import { isInsideRoot, nextFireGap } from '../src/registry.ts'
import { CONFIG_JOB, createInput, makeRegistry, storedRow } from './support.ts'

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
      state: { 'pr-check': { notes: 'Round two.', lastRuns: [{ firedAt: 1, sessionId: 's', outcome: 'answered' }] } },
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

  it('refuses every mutation of a configured job, naming the action', async () => {
    const { registry } = makeRegistry([CONFIG_JOB])
    await expect(registry.update(CONFIG_JOB.name, { prompt: 'x' })).rejects.toThrow('comes from configuration; update applies to stored jobs only')
    await expect(registry.setEnabled(CONFIG_JOB.name, false)).rejects.toThrow('pause applies to stored jobs only')
    await expect(registry.remove(CONFIG_JOB.name)).rejects.toThrow('delete applies to stored jobs only')
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
    await expect(registry.setNotes('pr-check', 'x'.repeat(401))).rejects.toThrow('above the cap of 400')
  })

  it('prepends run history newest-first, bounded by the keep count', async () => {
    const { registry, stateTable } = makeRegistry()
    await registry.recordRun('pr-check', { firedAt: 1, sessionId: 'a', outcome: 'answered' }, 2)
    await registry.recordRun('pr-check', { firedAt: 2, sessionId: 'b', outcome: 'timed-out' }, 2)
    await registry.recordRun('pr-check', { firedAt: 3, sessionId: 'c', outcome: 'failed' }, 2)
    expect(stateTable.rows.get('pr-check')?.lastRuns).toEqual([
      { firedAt: 3, sessionId: 'c', outcome: 'failed' },
      { firedAt: 2, sessionId: 'b', outcome: 'timed-out' },
    ])
  })

  it('keeps notes while recording runs and survives a zero keep count', async () => {
    const { registry, stateTable } = makeRegistry()
    await expect(registry.setNotes('ghost-notes', 'x')).rejects.toThrow('no job named')
    await registry.recordRun('any-job', { firedAt: 1, sessionId: 'a', outcome: 'answered' }, 0)
    expect(stateTable.rows.get('any-job')?.lastRuns).toEqual([])
    expect(registry.list()).toEqual([])
  })
})
