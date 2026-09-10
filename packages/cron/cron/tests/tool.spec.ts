import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createCronManageTool } from '../src/tool.ts'
import { CONFIG_JOB, makeRegistry, storedRow } from './support.ts'

/** Registry plus tool over a context whose approval service answers `approvalOutcome`. */
function setup(
  options: Parameters<typeof makeRegistry>[1] = {},
  deps: {
    readonly requireApproval?: boolean
    readonly approvalOutcome?: 'allowed-once' | 'rejected'
    readonly armed?: boolean
  } = {},
) {
  const { registry, jobsTable, stateTable } = makeRegistry([CONFIG_JOB], options)
  const approval = deps.approvalOutcome === undefined
    ? undefined
    : { request: vi.fn(async () => deps.approvalOutcome as string) }
  const ctx = { get: (service: string) => service === 'approval' ? approval : undefined } as unknown as Context
  const exec = {
    agent: { session: { header: { id: 'session-1' } } },
    callId: 'call-1',
    signal: new AbortController().signal,
  }
  const runNow = vi.fn((): boolean => deps.armed ?? true)
  const tool = createCronManageTool(ctx, registry, { requireApproval: deps.requireApproval ?? false, runNow })
  return { registry, jobsTable, stateTable, runNow, approval, tool, exec: exec as never }
}

/** A full create argument set in the model-facing snake_case spelling. */
const CREATE_ARGS = {
  action: 'create' as const,
  name: 'pr-check',
  expression: '0 9 * * 1',
  timezone: 'Europe/Zagreb',
  prompt: 'Check open pull requests.',
  agent_preset: 'beardy',
  permission_preset: 'workspace-write',
  workspace_path: '/srv/repo',
}

describe('cron_manage tool', () => {
  it('lists every job with origin and arm state, marking stored notes', async () => {
    const h = setup({ stored: [storedRow('pr-check', { enabled: false })], state: { 'pr-check': { notes: 'hi', lastRuns: [] } } })
    const result = await h.tool.execute({ action: 'list' }, h.exec) as { message: string; jobs?: string[] }
    expect(result.message).toBe('2 job(s).')
    expect(result.jobs?.some(line => line.includes('morning-brief') && line.includes('(config)'))).toBe(true)
    expect(result.jobs?.some(line => line.includes('stored, paused') && line.includes('[has notes]'))).toBe(true)
  })

  it('marks a paused configured job in the listing', async () => {
    const h = setup({ state: { 'morning-brief': { notes: '', lastRuns: [], enabled: false } } })
    const result = await h.tool.execute({ action: 'list' }, h.exec) as { jobs?: string[] }
    expect(result.jobs?.some(line => line.includes('morning-brief') && line.includes('config, paused'))).toBe(true)
  })

  it('pauses and resumes a configured job through the tool', async () => {
    const h = setup()
    expect(await h.tool.execute({ action: 'pause', name: 'morning-brief' }, h.exec)).toMatchObject({
      action: 'pause', message: 'Paused job morning-brief: 0 7 * * * Europe/Zagreb (config, paused).',
    })
    expect(h.stateTable.rows.get('morning-brief')?.enabled).toBe(false)
    expect(await h.tool.execute({ action: 'resume', name: 'morning-brief' }, h.exec)).toMatchObject({ action: 'resume' })
    expect(h.stateTable.rows.get('morning-brief')?.enabled).toBe(true)
  })

  it('creates a stored job without approval when the operator disabled the gate', async () => {
    const h = setup()
    expect(await h.tool.execute(CREATE_ARGS, h.exec)).toMatchObject({ action: 'create', name: 'pr-check' })
    expect(h.jobsTable.rows.get('pr-check')?.createdBy).toBe('session-1')
  })

  it('asks approval with a descriptive reason before creating', async () => {
    const h = setup({}, { requireApproval: true, approvalOutcome: 'allowed-once' })
    expect(await h.tool.execute(CREATE_ARGS, h.exec)).toMatchObject({ action: 'create' })
    const [askCall] = h.approval?.request.mock.calls as unknown[][]
    const asked = (askCall?.[0] ?? {}) as { toolName?: string; callId?: string; reason?: string }
    expect(asked).toMatchObject({ toolName: 'cron_manage', callId: 'call-1' })
    expect(asked.reason).toContain('Cron create: "pr-check"')
    expect(h.jobsTable.rows.has('pr-check')).toBe(true)
  })

  it('changes nothing when approval is denied or the service is missing', async () => {
    const denied = setup({}, { requireApproval: true, approvalOutcome: 'rejected' })
    await expect(denied.tool.execute(CREATE_ARGS, denied.exec))
      .rejects.toThrow('was not approved (rejected); nothing changed')
    expect(denied.jobsTable.rows.has('pr-check')).toBe(false)

    const unmounted = setup({}, { requireApproval: true })
    await expect(unmounted.tool.execute(CREATE_ARGS, unmounted.exec))
      .rejects.toThrow('no approval service is mounted')
  })

  it('patches stored jobs through update and refuses configured ones', async () => {
    const h = setup({ stored: [storedRow('pr-check')] }, { requireApproval: true, approvalOutcome: 'allowed-once' })
    expect(await h.tool.execute({ action: 'update', name: 'pr-check', prompt: 'Check PRs nightly.' }, h.exec))
      .toMatchObject({ action: 'update' })
    expect(h.jobsTable.rows.get('pr-check')?.prompt).toBe('Check PRs nightly.')
    await expect(h.tool.execute({ action: 'update', name: CONFIG_JOB.name, prompt: 'x' }, h.exec))
      .rejects.toThrow('comes from configuration')
  })

  it('pauses, resumes, and deletes stored jobs', async () => {
    const h = setup({ stored: [storedRow('pr-check')] })
    expect(await h.tool.execute({ action: 'pause', name: 'pr-check' }, h.exec)).toMatchObject({ action: 'pause' })
    expect(h.jobsTable.rows.get('pr-check')?.enabled).toBe(false)
    expect(await h.tool.execute({ action: 'resume', name: 'pr-check' }, h.exec)).toMatchObject({ action: 'resume' })
    expect(await h.tool.execute({ action: 'delete', name: 'pr-check' }, h.exec)).toMatchObject({ action: 'delete' })
    expect(h.jobsTable.rows.has('pr-check')).toBe(false)
  })

  it('runs armed jobs now and refuses unknown or paused names', async () => {
    const h = setup({ stored: [storedRow('pr-check', { enabled: false })] })
    const started = (await h.tool.execute({ action: 'run_now', name: CONFIG_JOB.name }, h.exec)) as { message?: string }
    expect(started.message).toContain('outside its schedule')
    expect(h.runNow).toHaveBeenCalledWith('morning-brief')
    await expect(h.tool.execute({ action: 'run_now', name: 'ghost' }, h.exec)).rejects.toThrow('no job named "ghost"')
    const paused = setup({ stored: [storedRow('pr-check', { enabled: false })] }, { armed: false })
    await expect(paused.tool.execute({ action: 'run_now', name: 'pr-check' }, paused.exec))
      .rejects.toThrow('paused; resume it first')
  })

  it('replaces continuity notes and reports the cap rejection', async () => {
    const h = setup()
    const noted = (await h.tool.execute({ action: 'note', name: CONFIG_JOB.name, notes: 'Weather source flaky.' }, h.exec)) as { action?: string; message?: string }
    expect(noted.action).toBe('note')
    expect(noted.message).toContain('replaced')
    expect(h.stateTable.rows.get('morning-brief')?.notes).toBe('Weather source flaky.')
    await expect(h.tool.execute({ action: 'note', name: CONFIG_JOB.name, notes: 'x'.repeat(401) }, h.exec))
      .rejects.toThrow('above the cap of 400')
  })

  it('requires a name for every single-job action and full definitions on create', async () => {
    const h = setup()
    await expect(h.tool.execute({ action: 'pause' }, h.exec)).rejects.toThrow('needs "name"')
    await expect(h.tool.execute({ action: 'create', name: '  ', expression: '0 9 * * 1' }, h.exec))
      .rejects.toThrow('needs "name"')
    await expect(h.tool.execute({ action: 'create', name: 'half-defined', expression: '0 9 * * 1' }, h.exec))
      .rejects.toThrow('agent preset "" is not allowed')
  })

  it('accepts optional create fields and an agent-less execution', async () => {
    const h = setup()
    expect(await h.tool.execute({ ...CREATE_ARGS, title: 'PR sweep', deliver_channel: 'chan-7' }, h.exec))
      .toMatchObject({ action: 'create' })
    expect(h.jobsTable.rows.get('pr-check')).toMatchObject({
      title: 'PR sweep', deliver: { kind: 'channel', channelId: 'chan-7' },
    })
    const agentless = setup()
    const noAgent = { callId: 'c', signal: new AbortController().signal } as never
    expect(await agentless.tool.execute({ ...CREATE_ARGS, name: 'headless' }, noAgent)).toMatchObject({ action: 'create' })
    expect(agentless.jobsTable.rows.get('headless')?.createdBy).toBeUndefined()
    const gated = setup({}, { requireApproval: true, approvalOutcome: 'allowed-once' })
    await expect(gated.tool.execute(CREATE_ARGS, noAgent)).rejects.toThrow('requires an Agent-backed session')
  })

  it('clears delivery on update and defaults missing notes to empty', async () => {
    const h = setup({ stored: [storedRow('pr-check', { deliver: { kind: 'channel', channelId: 'chan-1' } })] })
    expect(await h.tool.execute({ action: 'update', name: 'pr-check', deliver_channel: '' }, h.exec))
      .toMatchObject({ action: 'update' })
    expect(h.jobsTable.rows.get('pr-check')?.deliver).toEqual({ kind: 'none' })
    await h.tool.execute({ action: 'note', name: CONFIG_JOB.name }, h.exec)
    expect(h.stateTable.rows.get('morning-brief')?.notes).toBe('')
  })

  it('patches every update field in one call through the tool', async () => {
    const h = setup({ stored: [storedRow('pr-check')] })
    expect(await h.tool.execute({
      action: 'update', name: 'pr-check', expression: '0 */3 * * *', timezone: 'UTC', prompt: 'Every three hours.',
      agent_preset: 'beardy', permission_preset: 'workspace-write', workspace_path: '/srv/other', title: 'Renamed',
    }, h.exec)).toMatchObject({ action: 'update' })
    expect(h.jobsTable.rows.get('pr-check')).toMatchObject({
      expression: '0 */3 * * *', timezone: 'UTC', prompt: 'Every three hours.', workspacePath: '/srv/other', title: 'Renamed',
    })
  })

  it('gates delete on approval and describes a partial create in the reason', async () => {
    const h = setup({ stored: [storedRow('pr-check')] }, { requireApproval: true, approvalOutcome: 'allowed-once' })
    expect(await h.tool.execute({ action: 'delete', name: 'pr-check' }, h.exec)).toMatchObject({ action: 'delete' })
    const deleteAsk = ((h.approval?.request.mock.calls as unknown[][])?.[0]?.[0] ?? {}) as { reason?: string }
    expect(deleteAsk.reason).toContain('Cron delete')
    await expect(h.tool.execute({ action: 'create', name: 'sparse' }, h.exec))
      .rejects.toThrow('is not allowed')
    const calls = h.approval?.request.mock.calls as { reason?: string }[][]
    expect(calls[1]?.[0]?.reason).toContain('"sparse" (? ?) preset ?/? in ?')
  })

  it('renders the message and job lines for display', async () => {
    const h = setup()
    const listed = await h.tool.execute({ action: 'list' }, h.exec) as { message: string; jobs?: string[] }
    expect(h.tool.output.render({ action: 'list' }, listed as never)).toEqual([
      { type: 'text', text: `${listed.message}\n${(listed.jobs ?? []).join('\n')}` },
    ])
    const noted = await h.tool.execute({ action: 'note', name: CONFIG_JOB.name, notes: 'short' }, h.exec) as { message: string }
    expect(h.tool.output.render({ action: 'note' }, noted as never)).toEqual([{ type: 'text', text: noted.message }])
  })

  it('is registered under the model-visible name with an action enum', () => {
    const h = setup()
    expect(h.tool.name).toBe('cron_manage')
    const action = (h.tool.parameters as { properties: Record<string, { enum?: string[] }> }).properties.action as { enum?: string[] }
    expect(action.enum).toContain('run_now')
  })
})
