import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { registerCronRunJob } from '../src/launch.ts'
import { createCronManageTool } from '../src/tool.ts'
import { CONFIG_JOB, makeRegistry, storedRow } from './support.ts'

/** Registry plus tool over a context whose approval service answers `approvalOutcome`. */
function setup(
  options: Parameters<typeof makeRegistry>[1] = {},
  deps: {
    readonly requireApproval?: boolean
    readonly approvalOutcome?: 'allowed-once' | 'rejected' | 'unavailable'
    readonly armed?: boolean
  } = {},
) {
  const { registry, jobsTable, stateTable } = makeRegistry([CONFIG_JOB], options)
  const approval = deps.approvalOutcome === undefined
    ? undefined
    : { request: vi.fn(async () => deps.approvalOutcome as string) }
  const logger = { info: vi.fn() }
  const ctx = new Context().extend({ get: (service: string) => service === 'approval' ? approval : undefined, logger })
  const exec = {
    agent: { session: { header: { id: 'session-1' } } },
    callId: 'call-1',
    signal: new AbortController().signal,
  }
  const runNow = vi.fn((): boolean => deps.armed ?? true)
  const tool = createCronManageTool(ctx, registry, { requireApproval: deps.requireApproval ?? false, runNow })
  return { registry, jobsTable, stateTable, runNow, approval, logger, tool, exec: exec as never, agent: exec.agent as never }
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
    expect(await h.tool.execute({ ...CREATE_ARGS, turn_timeout_ms: 12_000 }, h.exec))
      .toMatchObject({ action: 'create', name: 'pr-check' })
    expect(h.jobsTable.rows.get('pr-check')?.createdBy).toBe('session-1')
    expect(h.jobsTable.rows.get('pr-check')?.turnTimeoutMs).toBe(12_000)
  })

  it('asks approval with the complete proposed job before creating', async () => {
    const h = setup({}, { requireApproval: true, approvalOutcome: 'allowed-once' })
    expect(await h.tool.execute({ ...CREATE_ARGS, title: 'PR sweep', turn_timeout_ms: 3_000, deliver_channel: '123456789012345678' }, h.exec))
      .toMatchObject({ action: 'create' })
    const [askCall] = h.approval?.request.mock.calls as unknown[][]
    const asked = (askCall?.[0] ?? {}) as { toolName?: string; callId?: string; reason?: string }
    expect(asked).toMatchObject({ toolName: 'cron_manage', callId: 'call-1' })
    for (const detail of [
      'name: "pr-check"', 'expression: "0 9 * * 1"', 'timezone: "Europe/Zagreb"',
      'prompt: "Check open pull requests."', 'agentPreset: "beardy"',
      'permissionPreset: "workspace-write"', 'workspacePath: "/srv/repo"',
      'title: "PR sweep"', 'turnTimeoutMs: 3000', 'deliverChannelId: "123456789012345678"', 'enabled: true',
    ]) expect(asked.reason).toContain(detail)
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
    expect(await h.tool.execute({ action: 'update', name: 'pr-check', prompt: 'Check PRs nightly.', turn_timeout_ms: 3_000 }, h.exec))
      .toMatchObject({ action: 'update' })
    expect(h.jobsTable.rows.get('pr-check')?.prompt).toBe('Check PRs nightly.')
    expect(h.jobsTable.rows.get('pr-check')?.turnTimeoutMs).toBe(3_000)
    const reason = ((h.approval?.request.mock.calls as unknown[][])[0]?.[0] as { reason: string }).reason
    expect(reason).toContain('prompt: "Check open pull requests." → "Check PRs nightly."')
    expect(reason).toContain('turnTimeoutMs: (none) → 3000')
    await expect(h.tool.execute({ action: 'update', name: CONFIG_JOB.name, prompt: 'x' }, h.exec))
      .rejects.toThrow('comes from configuration')
  })

  it('approves every patched field and applies the copied proposal', async () => {
    const h = setup({ stored: [storedRow('pr-check', { deliver: { kind: 'channel', channelId: 'chan-old' } })] },
      { requireApproval: true, approvalOutcome: 'allowed-once' })
    const args = {
      action: 'update' as const, name: 'pr-check', expression: '0 10 * * 1', timezone: 'UTC',
      prompt: 'Fresh prompt', agent_preset: 'beardy', permission_preset: 'workspace-write',
      workspace_path: '/srv/new', title: 'Fresh title', turn_timeout_ms: 5_000, deliver_channel: '',
    }
    h.approval?.request.mockImplementation(async () => {
      args.prompt = 'changed after approval'
      return 'allowed-once'
    })
    await h.tool.execute(args, h.exec)
    const reason = ((h.approval?.request.mock.calls as unknown[][])[0]?.[0] as { reason: string }).reason
    for (const detail of [
      'expression: "0 9 * * 1" → "0 10 * * 1"', 'timezone: "Europe/Zagreb" → "UTC"',
      'prompt: "Check open pull requests." → "Fresh prompt"',
      'agentPreset: "beardy" → "beardy"', 'permissionPreset: "workspace-write" → "workspace-write"',
      'workspacePath: "/srv/repo" → "/srv/new"', 'title: (none) → "Fresh title"',
      'turnTimeoutMs: (none) → 5000', 'deliverChannelId: "chan-old" → (none)',
    ]) expect(reason).toContain(detail)
    expect(h.jobsTable.rows.get('pr-check')).toMatchObject({ prompt: 'Fresh prompt', deliver: { kind: 'none' } })
  })

  it('applies the create proposal captured before approval', async () => {
    const h = setup({}, { requireApproval: true, approvalOutcome: 'allowed-once' })
    const args = { ...CREATE_ARGS, prompt: 'Approved prompt', deliver_channel: '123456789012345678' }
    h.approval?.request.mockImplementation(async () => {
      args.prompt = 'changed after approval'
      args.deliver_channel = 'signal:number:+15551234567'
      return 'allowed-once'
    })
    await h.tool.execute(args, h.exec)
    expect(h.jobsTable.rows.get('pr-check')).toMatchObject({ prompt: 'Approved prompt', deliver: { kind: 'channel', channelId: '123456789012345678' } })
  })

  it.each(['resume', 'run_now', 'note'] as const)('%s requires granted approval when enabled', async (action) => {
    const initiallyEnabled = action === 'run_now'
    const options = { state: { [CONFIG_JOB.name]: { notes: 'Old note', lastRuns: [], enabled: initiallyEnabled } } }
    const args = action === 'note'
      ? { action, name: CONFIG_JOB.name, notes: 'New note' }
      : { action, name: CONFIG_JOB.name }
    for (const outcome of ['allowed-once', 'rejected', undefined] as const) {
      const h = setup(options, { requireApproval: true, ...(outcome === undefined ? {} : { approvalOutcome: outcome }) })
      if (outcome === 'allowed-once') {
        await h.tool.execute(args, h.exec)
        const reason = ((h.approval?.request.mock.calls as unknown[][])[0]?.[0] as { reason: string }).reason
        expect(reason).toContain(`Cron ${action}:`)
        if (action === 'note') {
          expect(reason).toContain('notes: "Old note" → "New note"')
          expect(h.stateTable.rows.get(CONFIG_JOB.name)?.notes).toBe('New note')
        } else if (action === 'resume') {
          expect(reason).toContain('enabled: false → true')
          expect(h.stateTable.rows.get(CONFIG_JOB.name)?.enabled).toBe(true)
        } else {
          expect(reason).toContain('prompt: "Summarize the feeds."')
          expect(h.runNow).toHaveBeenCalledWith(CONFIG_JOB.name)
        }
      } else {
        await expect(h.tool.execute(args, h.exec))
          .rejects.toThrow(outcome === 'rejected' ? 'was not approved (rejected)' : 'no approval service is mounted')
        expect(h.stateTable.rows.get(CONFIG_JOB.name)).toMatchObject({ notes: 'Old note', enabled: initiallyEnabled })
        expect(h.runNow).not.toHaveBeenCalled()
      }
    }
  })

  it('refuses a patch when its approved old value changes before the answer', async () => {
    const h = setup({ stored: [storedRow('pr-check')] }, { requireApproval: true, approvalOutcome: 'allowed-once' })
    h.approval?.request.mockImplementation(async () => {
      h.jobsTable.rows.set('pr-check', storedRow('pr-check', { prompt: 'Changed meanwhile.' }))
      return 'allowed-once'
    })
    await expect(h.tool.execute({ action: 'update', name: 'pr-check', prompt: 'Approved replacement.' }, h.exec))
      .rejects.toThrow('changed while approval was pending')
    expect(h.jobsTable.rows.get('pr-check')?.prompt).toBe('Changed meanwhile.')
  })

  it.each(['resume', 'run_now', 'note'] as const)('%s refuses a changed job after approval', async (action) => {
    const h = setup({ state: { [CONFIG_JOB.name]: { notes: 'Old note', lastRuns: [], enabled: false } } },
      { requireApproval: true, approvalOutcome: 'allowed-once' })
    h.approval?.request.mockImplementation(async () => {
      h.stateTable.rows.set(CONFIG_JOB.name, { notes: 'Changed meanwhile.', lastRuns: [], enabled: false })
      return 'allowed-once'
    })
    const args = action === 'note'
      ? { action, name: CONFIG_JOB.name, notes: 'Approved replacement.' }
      : { action, name: CONFIG_JOB.name }
    await expect(h.tool.execute(args, h.exec)).rejects.toThrow('changed while approval was pending')
    expect(h.stateTable.rows.get(CONFIG_JOB.name)?.enabled).toBe(false)
    expect(h.stateTable.rows.get(CONFIG_JOB.name)?.notes).toBe('Changed meanwhile.')
    expect(h.runNow).not.toHaveBeenCalled()
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
      .rejects.toThrow('above the cap of 400; condense the continuity notes and retry')
  })

  it('lets a live run replace its own job notes without approval, within the cap', async () => {
    const h = setup({ state: { [CONFIG_JOB.name]: { notes: 'Old note', lastRuns: [] } } }, { requireApproval: true })
    const release = registerCronRunJob(h.agent, CONFIG_JOB.name)
    try {
      const noted = await h.tool.execute({ action: 'note', name: CONFIG_JOB.name, notes: 'Reported A.' }, h.exec) as { message: string }
      expect(noted.message).toContain('replaced')
      expect(h.stateTable.rows.get(CONFIG_JOB.name)?.notes).toBe('Reported A.')
      expect(h.logger.info).toHaveBeenCalledWith('dsh-cron: job "morning-brief" updated its continuity notes (11 chars)')
      await expect(h.tool.execute({ action: 'note', name: CONFIG_JOB.name, notes: 'x'.repeat(401) }, h.exec))
        .rejects.toThrow('above the cap of 400')
      expect(h.stateTable.rows.get(CONFIG_JOB.name)?.notes).toBe('Reported A.')
    } finally {
      release()
    }
    await expect(h.tool.execute({ action: 'note', name: CONFIG_JOB.name, notes: 'After the run.' }, h.exec))
      .rejects.toThrow('no approval service is mounted')
  })

  it('keeps approval for another job\'s notes and other actions from a live run', async () => {
    const h = setup({ stored: [storedRow('pr-check')], state: { 'pr-check': { notes: 'Theirs', lastRuns: [] } } }, { requireApproval: true })
    const release = registerCronRunJob(h.agent, CONFIG_JOB.name)
    try {
      await expect(h.tool.execute({ action: 'note', name: 'pr-check', notes: 'Overwritten.' }, h.exec))
        .rejects.toThrow('cron job note "pr-check" needs approval')
      await expect(h.tool.execute({ action: 'run_now', name: CONFIG_JOB.name }, h.exec))
        .rejects.toThrow('cron job run_now "morning-brief" needs approval')
      expect(h.stateTable.rows.get('pr-check')?.notes).toBe('Theirs')
      expect(h.logger.info).not.toHaveBeenCalled()
    } finally {
      release()
    }
    const unavailable = setup({ stored: [storedRow('pr-check')] }, { requireApproval: true, approvalOutcome: 'unavailable' })
    const releaseOther = registerCronRunJob(unavailable.agent, CONFIG_JOB.name)
    try {
      await expect(unavailable.tool.execute({ action: 'note', name: 'pr-check', notes: 'Overwritten.' }, unavailable.exec))
        .rejects.toThrow('cron job note "pr-check" was not approved (unavailable); nothing changed')
    } finally {
      releaseOther()
    }
  })

  it('requires a name for every single-job action and full definitions on create', async () => {
    const h = setup()
    await expect(h.tool.execute({ action: 'pause' }, h.exec)).rejects.toThrow('pause requires: name')
    await expect(h.tool.execute({ action: 'create', name: '  ', expression: '0 9 * * 1' }, h.exec))
      .rejects.toThrow('create requires: name, timezone, prompt, agent_preset, permission_preset, workspace_path')
    await expect(h.tool.execute({ action: 'create', name: 'half-defined', expression: '0 9 * * 1' }, h.exec))
      .rejects.toThrow('create requires: timezone, prompt, agent_preset, permission_preset, workspace_path')
    await expect(h.tool.execute({ action: 'update', name: 'pr-check' }, h.exec))
      .rejects.toThrow('update requires at least one of:')
    await expect(h.tool.execute({ action: 'note', name: CONFIG_JOB.name }, h.exec))
      .rejects.toThrow('note requires: notes')
  })

  it('accepts optional create fields and an agent-less execution', async () => {
    const h = setup()
    expect(await h.tool.execute({ ...CREATE_ARGS, title: 'PR sweep', deliver_channel: '123456789012345678' }, h.exec))
      .toMatchObject({ action: 'create' })
    expect(h.jobsTable.rows.get('pr-check')).toMatchObject({
      title: 'PR sweep', deliver: { kind: 'channel', channelId: '123456789012345678' },
    })
    const agentless = setup()
    const noAgent = { callId: 'c', signal: new AbortController().signal } as never
    expect(await agentless.tool.execute({ ...CREATE_ARGS, name: 'headless' }, noAgent)).toMatchObject({ action: 'create' })
    expect(agentless.jobsTable.rows.get('headless')?.createdBy).toBeUndefined()
    const gated = setup({}, { requireApproval: true, approvalOutcome: 'allowed-once' })
    await expect(gated.tool.execute(CREATE_ARGS, noAgent)).rejects.toThrow('requires an Agent-backed session')
  })

  it('rejects a delivery target no delivery owner can claim before approval', async () => {
    const h = setup({ stored: [storedRow('pr-check')] }, { requireApproval: true, approvalOutcome: 'allowed-once' })
    await expect(h.tool.execute({ ...CREATE_ARGS, name: 'fresh', deliver_channel: 'general' }, h.exec))
      .rejects.toThrow('deliver_channel must be a Discord channel id of 17 to 20 digits (optionally prefixed "discord:"), "signal:group:<base64 group id>", or "signal:number:<E.164 number>"')
    await expect(h.tool.execute({ ...CREATE_ARGS, name: 'fresh', deliver_channel: '' }, h.exec)).rejects.toThrow('deliver_channel must be')
    await expect(h.tool.execute({ action: 'update', name: 'pr-check', deliver_channel: 'signal:group:abc' }, h.exec))
      .rejects.toThrow('deliver_channel must be')
    expect(h.approval?.request).not.toHaveBeenCalled()
    await h.tool.execute({ action: 'update', name: 'pr-check', deliver_channel: 'signal:number:+15551234567' }, h.exec)
    expect(h.jobsTable.rows.get('pr-check')?.deliver).toEqual({ kind: 'channel', channelId: 'signal:number:+15551234567' })
  })

  it('clears delivery on update and clears notes with an empty replacement', async () => {
    const h = setup({ stored: [storedRow('pr-check', { deliver: { kind: 'channel', channelId: 'chan-1' } })] })
    expect(await h.tool.execute({ action: 'update', name: 'pr-check', deliver_channel: '' }, h.exec))
      .toMatchObject({ action: 'update' })
    expect(h.jobsTable.rows.get('pr-check')?.deliver).toEqual({ kind: 'none' })
    await h.tool.execute({ action: 'note', name: CONFIG_JOB.name, notes: '' }, h.exec)
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
      .rejects.toThrow('create requires: expression, timezone, prompt, agent_preset, permission_preset, workspace_path')
    const calls = h.approval?.request.mock.calls as { reason?: string }[][]
    expect(calls).toHaveLength(1)
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
    const properties = (h.tool.parameters as { properties: Record<string, { description?: string; type?: string }> }).properties
    expect(properties.name?.description).toContain('Required for create, update, delete, pause, resume, run_now, and note')
    expect(properties.turn_timeout_ms).toMatchObject({ type: 'number' })
    expect(h.tool.description).toContain('"update" requires name and at least one patch field')
  })

  it('keeps the complete model-visible schema in an owner-local expectation', async () => {
    const h = setup()
    await expect(JSON.stringify({ description: h.tool.description, parameters: h.tool.parameters }, null, 2) + '\n')
      .toMatchFileSnapshot('./expected/cron-manage.schema.json')
  })
})
