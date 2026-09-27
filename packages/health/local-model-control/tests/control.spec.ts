import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config, LocalModelController, resolveConfig } from '../src/index.ts'
import type { BackendConfig, Config as ControlConfig, LocalModelDeps } from '../src/index.ts'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const ornith: BackendConfig = { name: 'ornith', kind: 'docker', container: 'ornith-container',
  routes: ['subagent'], healthUrl: 'http://127.0.0.1:8000/v1/models', loadTimeoutMs: 100 }
const strix: BackendConfig = { name: 'qwen-strix', kind: 'halorun', profile: 'qwen-profile',
  sshTarget: 'beardy@192.168.1.182', routes: ['strix'], healthUrl: 'http://192.168.1.182:8000/v1/models',
  loadTimeoutMs: 100 }
const heldStrix: BackendConfig = { ...strix, holdFile: '~/.config/halorun-watchdog/paused' }

async function fixture(overrides: Partial<ControlConfig> = {}, fetcher?: typeof fetch) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-model-control-'))
  roots.push(root)
  const config = resolveConfig({ stateFile: join(root, 'state', 'models.json'), operatorName: 'Goran',
    allowedPresets: ['beardy', 'beardy-discord'], backends: [ornith, strix], groups: { gaming: ['ornith'] },
    commandTimeoutMs: 1000, healthPollMs: 1, graceMs: 10, ...overrides })
  const calls: SubprocessSpawnSpec[] = []
  let outcome: Pick<SubprocessHandle, 'done'> = { done: Promise.resolve({ exitCode: 0, signal: null }) }
  const handleFor = (done: SubprocessHandle['done']): SubprocessHandle => ({ done,
    stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
    collected: {}, terminate: () => {}, waitForExit: async () => true })
  const spawn = vi.fn((spec: SubprocessSpawnSpec): SubprocessHandle => {
    calls.push(spec)
    return handleFor(outcome.done)
  })
  const health = vi.fn(fetcher ?? (async () => new Response('', { status: 200 })))
  const deps: LocalModelDeps = { subprocess: { spawn }, fetch: health, now: () => Date.parse('2026-09-27T18:00:00.000Z'),
    wait: (ms, signal) => delay(ms, undefined, { signal }) }
  const controller = await LocalModelController.open(config, deps)
  const signal = new AbortController().signal
  return { controller, config, calls, spawn, health, signal, handleFor,
    setOutcome: (done: SubprocessHandle['done']) => { outcome = { done } } }
}

describe('local model controls', () => {
  it('answers status, rejects unknown backends and unauthorized presets without a process', async () => {
    const h = await fixture()
    expect((await h.controller.command('models', 'status', 'beardy', h.signal)).text)
      .toContain('ornith: available (subagent).')
    expect((await h.controller.command('models', 'status', 'beardy-mamabear', h.signal)).kind).toBe('error')
    expect((await h.controller.command('models', 'unload absent', 'beardy', h.signal)).text)
      .toContain('unknown backend')
    expect((await h.controller.command('models', 'load ornith extra', 'beardy', h.signal)).text)
      .toContain('Usage:')
    expect(h.calls).toHaveLength(0)
  })

  it('runs exact Docker argv, persists unload across restart, and loads only after healthy', async () => {
    const h = await fixture()
    expect((await h.controller.command('models', 'unload ornith', 'beardy', h.signal)).kind).toBe('success')
    expect(h.calls[0]).toMatchObject({ argv: ['docker', 'stop', 'ornith-container'],
      stdio: { stdin: 'ignore' }, graceMs: 10 })
    expect(h.controller.unloadedForRoute('subagent')).toEqual({ backend: 'ornith',
      intent: { by: 'Goran', at: '2026-09-27T18:00:00.000Z' } })
    const restarted = await LocalModelController.open(h.config, {
      subprocess: { spawn: h.spawn }, fetch: h.health, now: () => 1, wait: async () => {} })
    expect(restarted.unloadedForHealthUrl(ornith.healthUrl as string)?.backend).toBe('ornith')
    expect((await restarted.command('models', 'status', 'beardy', h.signal)).text)
      .toContain('unloaded by Goran at 2026-09-27T18:00:00.000Z')
    expect((await restarted.command('models', 'load ornith', 'beardy', h.signal)).kind).toBe('success')
    expect(h.calls[1]?.argv).toEqual(['docker', 'start', 'ornith-container'])
    expect(h.health).toHaveBeenCalledWith(ornith.healthUrl, expect.objectContaining({ method: 'GET' }))
    expect(restarted.unloadedForRoute('subagent')).toBeUndefined()
    expect(JSON.parse(await readFile(h.config.stateFile, 'utf8'))).toEqual({ version: 1, unloaded: {} })
  })

  it('keeps intentional unload after a load health timeout and shows the failed command', async () => {
    const h = await fixture({}, async () => new Response('', { status: 503 }))
    await h.controller.change('ornith', 'unload', h.signal)
    const result = await h.controller.command('models', 'load ornith', 'beardy', h.signal)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('health wait timed out')
    expect(h.controller.unloadedForRoute('subagent')?.backend).toBe('ornith')
  })

  it('runs exact remote halorun argv and leaves the desktop gaming group scoped to ornith', async () => {
    const h = await fixture()
    expect((await h.controller.command('models', 'unload qwen-strix', 'beardy-discord', h.signal)).kind).toBe('success')
    expect(h.calls[0]?.argv).toEqual(['ssh', '-o', 'BatchMode=yes', '--', 'beardy@192.168.1.182',
      'halorun', 'stop', 'qwen-profile'])
    expect((await h.controller.command('gaming', 'on', 'beardy', h.signal)).kind).toBe('success')
    expect(h.calls[1]?.argv).toEqual(['docker', 'stop', 'ornith-container'])
    expect((await h.controller.command('gaming', 'off', 'beardy', h.signal)).kind).toBe('success')
    expect(h.calls[2]?.argv).toEqual(['docker', 'start', 'ornith-container'])
    expect(h.controller.unloadedForRoute('strix')?.backend).toBe('qwen-strix')
    expect((await h.controller.command('gaming', 'pause', 'beardy', h.signal)).kind).toBe('error')
  })

  it('creates the remote watchdog hold before stopping and removes it before starting', async () => {
    const h = await fixture({ backends: [ornith, heldStrix] })
    expect((await h.controller.command('models', 'unload qwen-strix', 'beardy', h.signal)).kind).toBe('success')
    expect(h.calls.map(call => call.argv)).toEqual([
      ['ssh', '-o', 'BatchMode=yes', '--', 'beardy@192.168.1.182',
        'mkdir', '-p', '--', '~/.config/halorun-watchdog'],
      ['ssh', '-o', 'BatchMode=yes', '--', 'beardy@192.168.1.182',
        'touch', '--', '~/.config/halorun-watchdog/paused'],
      ['ssh', '-o', 'BatchMode=yes', '--', 'beardy@192.168.1.182',
        'halorun', 'stop', 'qwen-profile'],
    ])
    expect(h.controller.unloadedForRoute('strix')).toBeDefined()
    expect((await h.controller.command('models', 'load qwen-strix', 'beardy', h.signal)).kind).toBe('success')
    expect(h.calls.slice(3).map(call => call.argv)).toEqual([
      ['ssh', '-o', 'BatchMode=yes', '--', 'beardy@192.168.1.182',
        'rm', '-f', '--', '~/.config/halorun-watchdog/paused'],
      ['ssh', '-o', 'BatchMode=yes', '--', 'beardy@192.168.1.182',
        'halorun', 'start', 'qwen-profile'],
    ])
    expect(h.controller.unloadedForRoute('strix')).toBeUndefined()
  })

  it('refuses model control when a remote watchdog hold step fails', async () => {
    for (const failedStep of [0, 1]) {
      const h = await fixture({ backends: [ornith, heldStrix] })
      const respond = (exitCode: number) => (spec: SubprocessSpawnSpec): SubprocessHandle => {
        h.calls.push(spec)
        return h.handleFor(Promise.resolve({ exitCode, signal: null }))
      }
      if (failedStep === 1) h.spawn.mockImplementationOnce(respond(0))
      h.spawn.mockImplementationOnce(respond(1))
      const result = await h.controller.command('models', 'unload qwen-strix', 'beardy', h.signal)
      expect(result).toMatchObject({ kind: 'error' })
      expect(result.text).toContain('watchdog hold unload failed')
      expect(h.calls).toHaveLength(failedStep + 1)
      expect(h.calls.every(call => !call.argv.includes('halorun'))).toBe(true)
      expect(h.controller.unloadedForRoute('strix')).toBeUndefined()
    }
    const h = await fixture({ backends: [ornith, heldStrix] })
    await h.controller.change('qwen-strix', 'unload', h.signal)
    h.calls.length = 0
    h.setOutcome(Promise.resolve({ exitCode: 1, signal: null }))
    const result = await h.controller.command('models', 'load qwen-strix', 'beardy', h.signal)
    expect(result).toMatchObject({ kind: 'error' })
    expect(result.text).toContain('watchdog hold load failed')
    expect(h.calls.map(call => call.argv?.at(5))).toEqual(['rm'])
    expect(h.controller.unloadedForRoute('strix')).toBeDefined()
  })

  it('does not record an unload when the process exits unsuccessfully', async () => {
    const h = await fixture()
    h.setOutcome(Promise.resolve({ exitCode: 1, signal: null }))
    expect((await h.controller.command('models', 'unload ornith', 'beardy', h.signal)).text)
      .toContain('control command exited 1')
    expect(h.controller.unloadedForRoute('subagent')).toBeUndefined()
  })

  it('rejects command injection targets and inconsistent deployment config at mount', () => {
    const base: ControlConfig = { stateFile: '/tmp/models.json', operatorName: 'Goran',
      allowedPresets: ['beardy'], backends: [ornith] }
    expect(() => resolveConfig(Object.assign({}, base, { backends: [Object.assign({}, ornith, { container: 'x; rm -rf /' })] })))
      .toThrow('safe container')
    expect(() => resolveConfig(Object.assign({}, base, { backends: [Object.assign({}, strix, { sshTarget: '-oProxyCommand=evil' })] })))
      .toThrow('safe profile and SSH target')
    expect(() => resolveConfig(Object.assign({}, base, { backends: [ornith, Object.assign({}, strix, { routes: ['subagent'] })] })))
      .toThrow('duplicate provider route')
    expect(() => resolveConfig(Object.assign({}, base, { groups: { gaming: ['qwen-strix'] } }))).toThrow('distinct configured backends')
    expect(() => resolveConfig(Object.assign({}, base, { stateFile: 'relative' }))).toThrow('stateFile must be absolute')
    expect(Config(Object.assign({}, base, { groups: {} })).backends).toHaveLength(1)
  })

  it('rejects every malformed deployment target and timer before mounting', () => {
    const base: ControlConfig = { stateFile: '/tmp/models.json', operatorName: 'Goran',
      allowedPresets: ['beardy'], backends: [ornith] }
    const bad: [Partial<ControlConfig>, string][] = [
      [{ operatorName: ' ' }, 'operatorName'],
      [{ allowedPresets: [] }, 'allowedPresets'],
      [{ allowedPresets: ['beardy', 'beardy'] }, 'allowedPresets'],
      [{ allowedPresets: ['bad preset'] }, 'allowedPresets'],
      [{ commandTimeoutMs: 0 }, 'commandTimeoutMs'],
      [{ healthPollMs: 1.5 }, 'healthPollMs'],
      [{ graceMs: 2_147_483_648 }, 'graceMs'],
      [{ backends: [Object.assign({}, ornith, { name: 'Bad' })] }, 'invalid or duplicate backend'],
      [{ backends: [ornith, ornith] }, 'invalid or duplicate backend'],
      [{ backends: [Object.assign({}, ornith, { profile: 'extra' })] }, 'safe container'],
      [{ backends: [Object.assign({}, ornith, { holdFile: '~/paused' })] }, 'safe container'],
      [{ backends: [Object.assign({}, strix, { container: 'extra' })] }, 'safe profile and SSH target'],
      ...['paused', '~/../paused', '~//paused', '~/paused/', '~/pa used', '~/paused;touch',
        '~/$(touch bad)', '/etc/../paused', '/etc//paused'].map((holdFile): [Partial<ControlConfig>, string] =>
        [{ backends: [Object.assign({}, strix, { holdFile })] }, 'safe holdFile path']),
      [{ backends: [Object.assign({}, ornith, { routes: [] })] }, 'needs a provider route'],
      [{ backends: [Object.assign({}, ornith, { routes: ['Bad'] })] }, 'invalid or duplicate provider route'],
      [{ backends: [Object.assign({}, ornith, { loadTimeoutMs: 0 })] }, 'loadTimeoutMs'],
      [{ backends: [Object.assign({}, ornith, { healthUrl: 'invalid' })] }, 'invalid healthUrl'],
      [{ backends: [Object.assign({}, ornith, { healthUrl: 'ftp://host/models' })] }, 'distinct HTTP healthUrl'],
      [{ backends: [Object.assign({}, ornith, { healthUrl: 'http://user:pass@host/models' })] }, 'distinct HTTP healthUrl'],
      [{ backends: [Object.assign({}, ornith, { healthUrl: 'http://host/models#fragment' })] }, 'distinct HTTP healthUrl'],
      [{ backends: [ornith, Object.assign({}, strix, { healthUrl: ornith.healthUrl })] }, 'distinct HTTP healthUrl'],
      [{ groups: { models: ['ornith'] } }, 'group'],
      [{ groups: { gaming: [] } }, 'group'],
      [{ groups: { gaming: ['ornith', 'ornith'] } }, 'group'],
    ]
    for (const [overrides, message] of bad) {
      expect(() => resolveConfig(Object.assign({}, base, overrides))).toThrow(message)
    }
    const defaults = resolveConfig(base)
    expect([defaults.commandTimeoutMs, defaults.healthPollMs, defaults.graceMs]).toEqual([30_000, 1_000, 1_000])
    expect(resolveConfig(Object.assign({}, base, { backends: [heldStrix, Object.assign({}, strix, { name: 'other', routes: ['other'],
      healthUrl: 'http://192.168.1.183:8000/v1/models', holdFile: '/var/lib/watchdog/paused' })] })).backends[1]?.holdFile)
      .toBe('/var/lib/watchdog/paused')
  })

  it('refuses unknown, corrupt, or inaccessible durable state on restart', async () => {
    const h = await fixture()
    await mkdir(join(h.config.stateFile, '..'), { recursive: true })
    await writeFile(h.config.stateFile, '{broken')
    const deps: LocalModelDeps = { subprocess: { spawn: h.spawn }, fetch: h.health,
      now: () => 0, wait: async () => {} }
    await expect(LocalModelController.open(h.config, deps)).rejects.toThrow()
    await writeFile(h.config.stateFile, JSON.stringify({ version: 1,
      unloaded: { absent: { by: 'Goran', at: '2026-09-27T18:00:00.000Z' } } }))
    await expect(LocalModelController.open(h.config, deps)).rejects.toThrow('unknown backend')
    await rm(h.config.stateFile)
    await mkdir(h.config.stateFile)
    await expect(LocalModelController.open(h.config, deps)).rejects.toThrow()
  })

  it('keeps a successful unload paused in memory when state replacement fails', async () => {
    const h = await fixture()
    await mkdir(join(h.config.stateFile, '..'), { recursive: true })
    await mkdir(h.config.stateFile)
    await expect(h.controller.change('ornith', 'unload', h.signal)).rejects.toThrow()
    expect(h.controller.unloadedForRoute('subagent')?.intent.by).toBe('Goran')
    expect(h.calls[0]?.argv).toEqual(['docker', 'stop', 'ornith-container'])
    const unloaded = await fixture()
    await mkdir(join(unloaded.config.stateFile, '..'), { recursive: true })
    await mkdir(unloaded.config.stateFile)
    await expect(unloaded.controller.change('ornith', 'load', unloaded.signal)).rejects.toThrow()
    expect(unloaded.controller.unloadedForRoute('subagent')).toBeUndefined()
  })

  it('restores prior unload intent if clearing durable state fails', async () => {
    const h = await fixture()
    await h.controller.change('ornith', 'unload', h.signal)
    await rm(h.config.stateFile)
    await mkdir(h.config.stateFile)
    await expect(h.controller.change('ornith', 'load', h.signal)).rejects.toThrow()
    expect(h.controller.unloadedForRoute('subagent')?.intent.by).toBe('Goran')
  })

  it('handles command timeouts, cancellation, process signals, and consecutive commands', async () => {
    const h = await fixture({ commandTimeoutMs: 1 })
    h.setOutcome(delay(10).then(() => ({ exitCode: 0, signal: null })))
    await expect(h.controller.change('ornith', 'unload', h.signal)).rejects.toThrow('command timed out')
    h.setOutcome(Promise.resolve({ exitCode: null, signal: 'SIGTERM' }))
    await expect(h.controller.change('ornith', 'unload', h.signal)).rejects.toThrow('SIGTERM')
    const aborted = new AbortController()
    aborted.abort()
    await expect(h.controller.change('ornith', 'unload', aborted.signal)).rejects.toThrow()
    h.setOutcome(Promise.resolve({ exitCode: 0, signal: null }))
    await expect(h.controller.change('ornith', 'unload', h.signal)).resolves.toContain('unloaded')
  })

  it('retries transient health errors and works without a health URL', async () => {
    const health = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValue(new Response('', { status: 200 }))
    const h = await fixture({}, health)
    await h.controller.change('ornith', 'unload', h.signal)
    await expect(h.controller.change('ornith', 'load', h.signal)).resolves.toContain('loaded')
    expect(health).toHaveBeenCalledTimes(3)
    const withoutProbe = await fixture({ backends: [Object.assign({}, ornith, { healthUrl: undefined })] })
    await expect(withoutProbe.controller.change('ornith', 'load', withoutProbe.signal)).resolves.toBe('ornith: loaded.')
    expect(withoutProbe.health).not.toHaveBeenCalled()
    await h.controller.change('qwen-strix', 'load', h.signal)
    expect(h.calls.at(-1)?.argv).toEqual(['ssh', '-o', 'BatchMode=yes', '--', 'beardy@192.168.1.182',
      'halorun', 'start', 'qwen-profile'])
  })

  it('observes cancellation during health fetch and health backoff', async () => {
    const h = await fixture()
    const duringFetch = new AbortController()
    const fetchDeps: LocalModelDeps = { subprocess: { spawn: h.spawn },
      fetch: async () => { duringFetch.abort(); throw new Error('fetch aborted') },
      now: () => 0, wait: async () => {} }
    const fetchController = await LocalModelController.open(h.config, fetchDeps)
    await expect(fetchController.change('ornith', 'load', duringFetch.signal)).rejects.toThrow('fetch aborted')
    const duringWait = new AbortController()
    const waitDeps: LocalModelDeps = { subprocess: { spawn: h.spawn },
      fetch: async () => new Response('', { status: 503 }), now: () => 0,
      wait: async () => { duringWait.abort(); throw new Error('wait aborted') } }
    const waitController = await LocalModelController.open(h.config, waitDeps)
    await expect(waitController.change('ornith', 'load', duringWait.signal)).rejects.toThrow('wait aborted')
    expect(h.controller.unloadedForRoute('absent')).toBeUndefined()
    expect(h.controller.unloadedForHealthUrl('http://absent/v1/models')).toBeUndefined()
    expect(h.controller.unloadedForHealthUrl(ornith.healthUrl as string)).toBeUndefined()
  })

  it('reports empty status, malformed group input, and a member failure after earlier successes', async () => {
    const empty = await fixture({ backends: [], groups: {} })
    expect((await empty.controller.command('models', 'status', 'beardy', empty.signal)).text)
      .toBe('No local model backends configured.')
    expect((await empty.controller.command('gaming', 'on', 'beardy', empty.signal)).kind).toBe('error')
    const h = await fixture({ groups: { gaming: ['ornith', 'qwen-strix'] } })
    expect((await h.controller.command('gaming', 'on extra', 'beardy', h.signal)).kind).toBe('error')
    h.spawn.mockImplementationOnce((spec) => { h.calls.push(spec); return h.handleFor(Promise.resolve({ exitCode: 0, signal: null })) })
      .mockImplementationOnce((spec) => { h.calls.push(spec); return h.handleFor(Promise.resolve({ exitCode: 1, signal: null })) })
    const result = await h.controller.command('gaming', 'on', 'beardy', h.signal)
    expect(result.text).toContain('ornith: unloaded')
    expect(result.text).toContain('qwen-strix: control command exited 1')
    expect(h.controller.unloadedForRoute('subagent')).toBeDefined()
    vi.spyOn(h.controller, 'change').mockRejectedValueOnce(null)
    expect((await h.controller.command('models', 'load ornith', 'beardy', h.signal)).text).toContain('unknown error')
    vi.spyOn(h.controller, 'change').mockRejectedValueOnce(null)
    expect((await h.controller.command('gaming', 'off', 'beardy', h.signal)).text).toContain('unknown error')
  })

  it('mounts the Host service and human command handlers', async () => {
    const h = await fixture()
    interface RegisteredCommand {
      name: string
      handler: (invocation: {
        rawInput: string
        agent: { session: { header: { agentPreset: string } } }
        signal: AbortSignal
      }) => Promise<{ text: string }>
    }
    const registered: RegisteredCommand[] = []
    const removed: string[] = []
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
    const ctx = new Context()
    ctx.provide('subprocess', { spawn: h.spawn } as never)
    ctx.provide('commands', { register: (command: typeof registered[number]) => {
      registered.push(command)
      return () => { removed.push(command.name) }
    } } as never)
    await apply(ctx, h.config)
    expect(ctx.get('localModels')?.backends()).toHaveLength(2)
    expect(registered.map(command => command.name)).toEqual(['models', 'gaming'])
    const invocation = { rawInput: 'status', agent: { session: { header: { agentPreset: 'beardy' } } }, signal: h.signal }
    expect((await registered[0]?.handler(invocation))?.text).toContain('ornith: available')
    expect((await registered[1]?.handler({ ...invocation, rawInput: 'pause' }))?.text).toContain('Usage:')
    expect((await registered[0]?.handler({ ...invocation, rawInput: 'load ornith' }))?.text).toContain('health wait timed out')
    await ctx.fiber.dispose()
    expect(removed).toEqual(['gaming', 'models'])
  })
})
