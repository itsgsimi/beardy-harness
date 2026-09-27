import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { registerCronCommand, runCronSubcommand } from '../src/command.ts'
import { CONFIG_JOB, makeRegistry, storedRow } from './support.ts'

const deps = { runNow: vi.fn((): boolean => true) }

describe('/cron subcommands', () => {
  it('answers an empty or list input with the armed schedules', async () => {
    const { registry } = makeRegistry([CONFIG_JOB], { stored: [storedRow('pr-check')] })
    for (const input of ['', 'list']) {
      const result = await runCronSubcommand(input, registry, deps)
      expect(result.kind).toBe('success')
      const text = result.kind === 'success' ? result.text ?? '' : ''
      expect(text).toContain('morning-brief: 0 7 * * * Europe/Zagreb (config), next ')
      expect(text).toContain('pr-check: 0 9 * * 1 Europe/Zagreb (stored), next ')
    }
  })

  it('says so when there are no jobs at all', async () => {
    const { registry } = makeRegistry()
    expect(await runCronSubcommand('list', registry, deps)).toEqual({ kind: 'success', text: 'No cron jobs.' })
    expect(await runCronSubcommand('status', registry, deps)).toEqual({ kind: 'success', text: 'No cron jobs.' })
  })

  it('formats status, duration, failure cause, and the next fire for one or every job', async () => {
    const { registry } = makeRegistry([CONFIG_JOB], { state: { 'morning-brief': {
      notes: '', lastRuns: [{ firedAt: Date.parse('2026-09-26T07:00:00.000Z'), sessionId: 's-brief',
        outcome: 'failed', durationMs: 1250, failure: { code: 'TRANSPORT', message: 'Connection error' } }],
    } } })
    const one = await runCronSubcommand('status morning-brief', registry, deps)
    expect(one.kind).toBe('success')
    expect(one.text).toContain('failed at 2026-09-26T07:00:00.000Z (Session s-brief, duration 1250 ms, cause TRANSPORT: Connection error)')
    expect(one.text).toMatch(/; next \d{4}-\d\d-\d\dT/)
    expect(await runCronSubcommand('status', registry, deps)).toEqual(one)
    expect(await runCronSubcommand('status absent', registry, deps)).toEqual({ kind: 'error', text: 'no job named "absent"' })
  })

  it('reports an unrun job and legacy history without duration', async () => {
    const { registry } = makeRegistry([CONFIG_JOB])
    expect((await runCronSubcommand('status morning-brief', registry, deps)).text).toContain('never run')
    const { registry: old } = makeRegistry([CONFIG_JOB], { state: { 'morning-brief': {
      notes: '', lastRuns: [{ firedAt: 1, sessionId: 'old', outcome: 'answered' }],
    } } })
    expect((await runCronSubcommand('status morning-brief', old, deps)).text).toContain('duration unknown')
  })

  it('shows a skipped fire as an outcome without a Session', async () => {
    const { registry } = makeRegistry([CONFIG_JOB], { state: { 'morning-brief': {
      notes: '', lastRuns: [{ firedAt: 1, sessionId: 'cron-skipped-id', outcome: 'skipped', durationMs: 0,
        failure: { code: 'PREVIOUS_RUN_IN_PROGRESS', message: 'The previous run was still in progress.' } }],
    } } })
    expect((await runCronSubcommand('status morning-brief', registry, deps)).text)
      .toContain('skipped at 1970-01-01T00:00:00.001Z (Outcome cron-skipped-id, duration 0 ms, cause PREVIOUS_RUN_IN_PROGRESS: The previous run was still in progress.)')
  })

  it('marks paused stored jobs and omits a next-run time for them', async () => {
    const { registry } = makeRegistry([], { stored: [storedRow('pr-check', { enabled: false })] })
    const result = await runCronSubcommand('list', registry, deps)
    expect(result).toEqual({ kind: 'success', text: 'pr-check: paused (0 9 * * 1 Europe/Zagreb, stored)' })
    expect((await runCronSubcommand('status pr-check', registry, deps)).text).toBe('pr-check: never run; next paused')
  })

  it('starts an armed job on run and reports the start', async () => {
    const { registry } = makeRegistry([CONFIG_JOB])
    expect(await runCronSubcommand('run morning-brief', registry, deps)).toEqual({
      kind: 'success', text: 'Started "morning-brief" outside its schedule.',
    })
    expect(deps.runNow).toHaveBeenCalledWith('morning-brief')
  })

  it('refuses to run an unknown or paused job', async () => {
    const { registry } = makeRegistry([], { stored: [storedRow('pr-check', { enabled: false })] })
    const notArmed = { runNow: vi.fn((): boolean => false) }
    expect(await runCronSubcommand('run pr-check', registry, notArmed)).toEqual({
      kind: 'error', text: 'job "pr-check" is paused; resume it first',
    })
    expect(await runCronSubcommand('run ghost', registry, deps))
      .toEqual({ kind: 'error', text: 'no job named "ghost"' })
    const usage = await runCronSubcommand('run', registry, deps)
    expect(usage.kind).toBe('error')
    expect(JSON.stringify(usage)).toContain('which job?')
  })

  it('pauses, resumes, and deletes stored jobs through the command', async () => {
    const { registry, jobsTable } = makeRegistry([], { stored: [storedRow('pr-check')] })
    expect(await runCronSubcommand('pause pr-check', registry, deps)).toEqual({
      kind: 'success', text: 'Paused "pr-check"; its definition and notes stay.',
    })
    expect(jobsTable.rows.get('pr-check')?.enabled).toBe(false)
    expect((await runCronSubcommand('resume pr-check', registry, deps)).kind).toBe('success')
    expect((await runCronSubcommand('delete pr-check', registry, deps)).kind).toBe('success')
    expect(jobsTable.rows.has('pr-check')).toBe(false)
  })

  it('pauses and resumes a configured job through the command', async () => {
    const { registry, jobsTable, stateTable } = makeRegistry([CONFIG_JOB])
    expect(await runCronSubcommand('pause morning-brief', registry, deps)).toEqual({
      kind: 'success', text: 'Paused "morning-brief"; its definition and notes stay.',
    })
    expect(jobsTable.rows.has('morning-brief')).toBe(false)
    expect(stateTable.rows.get('morning-brief')?.enabled).toBe(false)
    const paused = await runCronSubcommand('list', registry, deps)
    expect(paused).toEqual({ kind: 'success', text: 'morning-brief: paused (0 7 * * * Europe/Zagreb, config)' })
    expect((await runCronSubcommand('resume morning-brief', registry, deps)).kind).toBe('success')
  })

  it('turns guardrail refusals into error results instead of throwing', async () => {
    const { registry } = makeRegistry([CONFIG_JOB])
    expect(await runCronSubcommand('delete morning-brief', registry, deps)).toEqual({
      kind: 'error', text: 'dsh-cron: job "morning-brief" comes from configuration; delete applies to stored jobs only',
    })
  })

  it('lists an armed job whose bounded schedule has no fire left', async () => {
    const { registry } = makeRegistry([], { stored: [storedRow('late-bloom', { expression: '0 0 12 31 12 * 2020' })] })
    const result = await runCronSubcommand('list', registry, deps)
    expect(result).toEqual({ kind: 'success', text: 'late-bloom: 0 0 12 31 12 * 2020 Europe/Zagreb (stored)' })
    expect((await runCronSubcommand('status late-bloom', registry, deps)).text).toBe('late-bloom: never run; next none')
  })

  it('reports a thrown non-error from the registry as its string form', async () => {
    const broken = { list: () => { throw 'plain boom' } } as never
    expect(await runCronSubcommand('list', broken, deps)).toEqual({ kind: 'error', text: 'plain boom' })
  })

  it('answers unknown verbs and missing names with the usage line', async () => {
    const { registry } = makeRegistry()
    const usage = 'usage: /cron list | status [name] | run <name> | pause <name> | resume <name> | delete <name>'
    expect(await runCronSubcommand('explode everything', registry, deps)).toEqual({ kind: 'error', text: usage })
    for (const verb of ['run', 'pause', 'resume', 'delete']) {
      expect(await runCronSubcommand(verb, registry, deps)).toEqual({
        kind: 'error', text: `which job? ${usage}`,
      })
    }
  })

  it('registers the command with hint and dispatch through the command registry', async () => {
    const registered: { name: string; description?: string; input?: unknown; handler?: unknown }[] = []
    const ctx = new Context().extend({ commands: { register: (c: { name: string }) => { registered.push(c); return () => {} } } })
    const { registry } = makeRegistry([CONFIG_JOB])
    registerCronCommand(ctx, registry, deps)
    expect(registered).toHaveLength(1)
    expect(registered[0]?.name).toBe('cron')
    expect(typeof registered[0]?.description).toBe('string')
    expect(typeof (registered[0]?.input as { hint?: unknown } | undefined)?.hint).toBe('string')
    const handler = registered[0]?.handler as (invocation: { rawInput: string }) => Promise<{ kind: string }>
    expect((await handler({ rawInput: 'list' })).kind).toBe('success')
  })
})
