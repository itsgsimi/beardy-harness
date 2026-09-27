import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import * as Homelab from '../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** Scripted subprocess provider: records specs and replays one configured outcome. */
class FakeSubprocess extends SubprocessRuntime {
  specs: SubprocessSpawnSpec[] = []
  output: string | undefined = '[]\n'
  outcome: SubprocessOutcome = { exitCode: 0, signal: null }
  lossy = false
  mode: 'settle' | 'wait-abort' | 'throw' | 'reject' = 'settle'
  override async terminalEnvironment() { return { platform: 'posix' as const } }
  override async resolveExecutable(command: string) { return command }
  override spawnTerminal(): Promise<never> { throw new Error('unexpected terminal') }
  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.specs.push(spec)
    if (this.mode === 'throw') throw new Error('spawn refused')
    const done = this.mode === 'reject' ? Promise.reject(new Error('provider failed'))
      : this.mode === 'wait-abort'
        ? new Promise<SubprocessOutcome>((resolve) => {
          spec.signal?.addEventListener('abort', () => { resolve({ exitCode: null, signal: 'SIGTERM' }) }, { once: true })
        })
        : Promise.resolve(this.outcome)
    const output = this.output
    const lossy = this.lossy
    return {
      stdin: undefined, stdout: undefined, stderr: undefined, control: undefined, done,
      collected: {
        ...output === undefined ? {} : { stdout: { readFrom: () => ({ text: output, nextOffset: Buffer.byteLength(output), lossy }) } },
        stderr: { readFrom: () => ({ text: 'secret stderr', nextOffset: 13, lossy: false }) },
      },
      terminate() {},
      waitForExit: async () => true,
    }
  }
}

async function beardyTree(inventory: unknown = { hosts: [{ id: 'mini' }, { id: 'pihole' }, { id: 'rig' }, 'bad'] }) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-homelab-'))
  roots.push(root)
  await mkdir(join(root, 'bin'))
  await mkdir(join(root, 'src'))
  await mkdir(join(root, 'inventory'))
  await writeFile(join(root, 'bin', 'bdy'), '#!/bin/sh\nexit 97\n')
  await chmod(join(root, 'bin', 'bdy'), 0o755)
  await writeFile(join(root, 'src', 'cli.ts'), '')
  await writeFile(join(root, 'inventory', 'hosts.json'), typeof inventory === 'string' ? inventory : JSON.stringify(inventory))
  return root
}

function configFor(root: string, overrides: Partial<Homelab.Config> = {}): Homelab.Config {
  return {
    bdyPath: join(root, 'bin', 'bdy'), secretsPath: join(root, 'secrets.env'),
    allowedHosts: ['mini', 'pihole'], allowedAgentPresets: ['beardy', 'beardy-discord'],
    timeoutMs: 2_000, bdyTimeoutSeconds: 1, graceMs: 50, maxStdoutBytes: 4_096, maxResultBytes: 1_024, maxCellChars: 64,
    ...overrides,
  }
}

function callerAgent(ctx: Context, preset: string | null, selected?: string): Agent {
  const id = SessionId(`homelab-${preset ?? 'none'}-${selected ?? 'header'}`)
  const session = Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false,
    ...preset === null ? {} : { agentPreset: preset },
  })
  if (selected !== undefined) session.append('agent-preset/selected', { agentPreset: selected })
  const agent: Agent = {
    id: session.id, options: {}, session, inbox: unsupportedInbox(), status: 'idle', ctx: ctx.plugin(() => {}).ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(agent)
  return agent
}

async function host(): Promise<{ ctx: Context; subprocess: FakeSubprocess }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(FakeSubprocess)
  return { ctx, subprocess: ctx.subprocess as FakeSubprocess }
}

async function harness(overrides: Partial<Homelab.Config> = {}, preset: string | null = 'beardy') {
  const root = await beardyTree()
  const { ctx, subprocess } = await host()
  const config = configFor(root, overrides)
  const fiber = await ctx.plugin(Homelab, config)
  const agent = callerAgent(ctx, preset)
  const call = (args: Record<string, unknown>, signal = new AbortController().signal) => ctx.tools.execute({
    name: 'homelab', arguments: args, callId: ToolCallId('homelab-call'), agent, signal,
  })
  const text = (result: Awaited<ReturnType<typeof call>>): string => {
    const block = result.content[0]
    return block?.type === 'text' ? block.text : ''
  }
  return { root, ctx, subprocess, config, fiber, call, text }
}

describe('homelab fixed Beardy reads', () => {
  it.each([
    ['hosts', ['hosts', 'list', '--no-probe'], [{ id: 'mini', addr: '192.168.1.123', user: 'goran', ssh: '-', role: 'server', tags: ['server', 'docker'] }],
      [{ id: 'mini', addr: '192.168.1.123', user: 'goran', role: 'server', tags: 'server,docker' }]],
    ['discover', ['discover', '--no-ping'], [{ ip: '192.168.1.123', name: 'mini', ping: '-', ssh: 'open', known: 'mini', services: 'ssh,http', mac: 'aa:bb' }],
      [{ ip: '192.168.1.123', name: 'mini', ping: '-', ssh: 'open', known: 'mini', services: 'ssh,http', mac: 'aa:bb' }]],
    ['dns', ['dns', '--resolvers'], [{ resolver: 'router', rcode: 'NOERROR', answer: '93.184.215.14', ms: 3, flag: '' }],
      [{ resolver: 'router', rcode: 'NOERROR', answer: '93.184.215.14', ms: 3, flag: '' }]],
    ['disk', ['disk'], [{ host: 'mini', mount: '/', type: 'ext4', size: '100G', used: '43G', avail: '57G', use: '43%', note: '' }],
      [{ host: 'mini', mount: '/', type: 'ext4', size: '100G', used: '43G', avail: '57G', use: '43%', note: '' }]],
    ['firewall_rules', ['fw', 'rules'], [{ seq: '10', sort: '1', on: 'lan', act: 'block', ip: 'inet', src: 'tv', dst: 'any', q: 'quick', desc: 'tv', uuid: 'u1' }],
      [{ seq: '10', sort: '1', on: 'lan', act: 'block', ip: 'inet', src: 'tv', dst: 'any', q: 'quick', desc: 'tv', uuid: 'u1' }]],
    ['router_leases', ['router', 'leases'], [{ ip: '192.168.1.23', mac: 'aa', hostname: 'tv', vendor: 'LG', iface: 'lan', until: '2026-09-28', type: 'dynamic' }],
      [{ ip: '192.168.1.23', mac: 'aa', hostname: 'tv', vendor: 'LG', iface: 'lan', until: '2026-09-28', type: 'dynamic' }]],
    ['net_top', ['net', 'talkers', '--window', '1h', '--limit', '10'], [{ rank: 1, ip: '192.168.1.23', name: 'tv', via: 'dhcp', vendor: 'LG', mbps_avg: '1.20', total: '20 MiB' }],
      [{ rank: 1, ip: '192.168.1.23', name: 'tv', via: 'dhcp', vendor: 'LG', mbps_avg: '1.20', total: '20 MiB' }]],
    ['doctor', ['doctor'], [{ item: 'node', state: 'ok', detail: '24.14.0', extra: 'dropped' }],
      [{ item: 'node', state: 'ok', detail: '24.14.0' }]],
  ] as const)('runs %s with exact argv and projects its columns', async (action, argv, printed, rows) => {
    const h = await harness()
    h.subprocess.output = `${JSON.stringify(printed, null, 2)}\n`
    const result = await h.call({ action })
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({ action, status: 'ok', rows, omittedRows: 0 })
    expect(JSON.parse(h.text(result))).toEqual(result.value)
    expect(h.subprocess.specs).toHaveLength(1)
    const [{ signal, ...spec }] = h.subprocess.specs as [SubprocessSpawnSpec]
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(spec).toEqual({
      argv: [h.config.bdyPath, '--json', '--timeout', '1', ...argv], cwd: h.root,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4_096 }, stderr: { maxBytes: 1_024 } },
      graceMs: 50, env: { BDY_SECRETS_FILE: h.config.secretsPath },
    })
  })

  it('reads a narrow Docker ps template for one allowlisted host and stringifies nested cells', async () => {
    const h = await harness()
    h.subprocess.output = '{"Names":"plex","Image":"plex:latest","State":"running","Status":"Up 2 hours","Ports":{"tcp":32400},"Labels":"x"}\n\n'
    const result = await h.call({ action: 'docker_status', host: 'mini' })
    expect(result.value).toEqual({
      action: 'docker_status', status: 'ok', omittedRows: 0,
      rows: [{ Names: 'plex', Image: 'plex:latest', State: 'running', Status: 'Up 2 hours', Ports: '{"tcp":32400}' }],
    })
    expect(h.subprocess.specs[0]?.argv.slice(1)).toEqual([
      '--json', '--timeout', '1', 'docker', 'mini', 'ps', '--all', '--format',
      '{"Names":{{json .Names}},"Image":{{json .Image}},"State":{{json .State}},"Status":{{json .Status}},"Ports":{{json .Ports}}}',
    ])
  })

  it('offers only the configured hosts and a read card', async () => {
    const h = await harness()
    const schema = h.ctx.tools.schemas().find(tool => tool.name === 'homelab')
    expect(schema?.parameters).toMatchObject({
      properties: { action: { enum: [...Homelab.HOMELAB_ACTIONS] }, host: { enum: ['mini', 'pihole'] } },
    })
    expect(h.ctx.tools.get('homelab')?.presentCall?.({ action: 'dns' })).toEqual({
      card: 'generic', title: 'Home lab', kind: 'read', rawInput: '{"action":"dns"}',
    })
  })

  it('drops docker_status and host when no Docker host is configured', async () => {
    const h = await harness({ allowedHosts: [] })
    const schema = h.ctx.tools.schemas().find(tool => tool.name === 'homelab')
    expect(schema?.parameters).toMatchObject({
      properties: { action: { enum: Homelab.HOMELAB_ACTIONS.filter(action => action !== 'docker_status') } },
    })
    expect(JSON.stringify(schema?.parameters)).not.toContain('"host"')
    expect(schema?.description).not.toContain('docker_status')
  })

  it.each([
    { action: 'ssh' }, { action: 'docker_status', host: 'rogue' }, { action: 'docker_status', host: '--yes' },
    { action: 'docker_status' }, { action: 'disk', host: 'mini' }, { action: 'hosts', extra: '--yes' },
    { action: 'fw', verb: 'apply' },
  ])('refuses %j before spawning', async (args) => {
    const h = await harness()
    const result = await h.call(args)
    expect(result.isError).toBe(true)
    expect(h.subprocess.specs).toEqual([])
  })

  it.each([['beardy-mamabear'], [null]])('refuses caller preset %s before spawning', async (preset) => {
    const h = await harness({}, preset)
    const result = await h.call({ action: 'hosts' })
    expect(result.isError).toBe(true)
    expect(h.text(result)).toContain('may not read home-lab data')
    expect(h.subprocess.specs).toEqual([])
  })

  it('authorizes the preset selected after creation when the registry projection is composed', async () => {
    const h = await harness()
    await h.ctx.plugin({ name: 'preset-projection', inject: ['sessionProjections'], apply: (inner: Context) => {
      inner.sessionProjections.register(agentPresetProjectionDefinition)
    } })
    const call = (agent: Agent) => h.ctx.tools.execute({
      name: 'homelab', arguments: { action: 'doctor' }, callId: ToolCallId('selected'), agent, signal: new AbortController().signal,
    })
    expect((await call(callerAgent(h.ctx, 'standard', 'beardy-discord'))).isError).toBe(false)
    expect((await call(callerAgent(h.ctx, 'beardy', 'beardy-mamabear'))).isError).toBe(true)
    expect((await call(callerAgent(h.ctx, null))).isError).toBe(true)
    expect(h.subprocess.specs).toHaveLength(1)
  })

  it('serves every caller, including Sessions without a preset, when configured with any', async () => {
    const h = await harness({ allowedAgentPresets: 'any' }, null)
    expect((await h.call({ action: 'doctor' })).isError).toBe(false)
  })

  it('refuses a Host-originated call without an Agent when presets are listed', async () => {
    const h = await harness()
    const result = await h.ctx.tools.execute({ name: 'homelab', arguments: { action: 'doctor' }, callId: ToolCallId('host'), signal: new AbortController().signal })
    expect(result.isError).toBe(true)
    expect(h.subprocess.specs).toEqual([])
  })

  it('reports a deadline as TIMEOUT and caller cancellation as a tool error', async () => {
    const h = await harness({ timeoutMs: 1_100, bdyTimeoutSeconds: 1 })
    h.subprocess.mode = 'wait-abort'
    expect((await h.call({ action: 'dns' })).value).toEqual({ action: 'dns', status: 'timeout', code: 'TIMEOUT', rows: [], omittedRows: 0 })
    const controller = new AbortController()
    const pending = h.call({ action: 'dns' }, controller.signal)
    controller.abort()
    expect((await pending).isError).toBe(true)
  })

  it('reports spawn failures, stdout loss, and unreadable secrets without Beardy text', async () => {
    const h = await harness()
    h.subprocess.mode = 'throw'
    expect((await h.call({ action: 'hosts' })).value).toMatchObject({ status: 'error', code: 'SPAWN_FAILED' })
    h.subprocess.mode = 'reject'
    expect((await h.call({ action: 'hosts' })).value).toMatchObject({ status: 'error', code: 'SPAWN_FAILED' })
    h.subprocess.mode = 'settle'
    h.subprocess.lossy = true
    expect((await h.call({ action: 'hosts' })).value).toMatchObject({ status: 'error', code: 'STDOUT_CAP' })
    h.subprocess.lossy = false
    h.subprocess.output = undefined
    expect((await h.call({ action: 'hosts' })).value).toMatchObject({ status: 'error', code: 'STDOUT_CAP' })
    h.subprocess.output = '[]'
    await mkdir(h.config.secretsPath)
    const unreadable = await h.call({ action: 'hosts' })
    expect(unreadable.value).toEqual({ action: 'hosts', status: 'error', code: 'SECRETS_UNREADABLE', rows: [], omittedRows: 0 })
    expect(JSON.stringify(unreadable)).not.toContain('secret stderr')
  })

  it('keeps rows Beardy printed before a nonzero exit and classifies malformed output', async () => {
    const h = await harness()
    h.subprocess.outcome = { exitCode: 1, signal: null }
    h.subprocess.output = JSON.stringify([{ host: 'rig', mount: '-', use: 'DOWN', note: 'Permission denied' }])
    expect((await h.call({ action: 'disk' })).value).toEqual({
      action: 'disk', status: 'error', code: 'BDY_EXIT', exitCode: 1, omittedRows: 0,
      rows: [{ host: 'rig', mount: '-', use: 'DOWN', note: 'Permission denied' }],
    })
    h.subprocess.outcome = { exitCode: null, signal: 'SIGKILL' }
    h.subprocess.output = 'Error: boom'
    expect((await h.call({ action: 'disk' })).value).toEqual({
      action: 'disk', status: 'error', code: 'BDY_EXIT', exitCode: null, rows: [], omittedRows: 0,
    })
    h.subprocess.outcome = { exitCode: 0, signal: null }
    expect((await h.call({ action: 'disk' })).value).toMatchObject({ status: 'error', code: 'INVALID_OUTPUT', rows: [] })
    h.subprocess.output = '{"host":"mini"}'
    expect((await h.call({ action: 'disk' })).value).toMatchObject({ status: 'error', code: 'INVALID_OUTPUT' })
    h.subprocess.output = '[1]'
    expect((await h.call({ action: 'disk' })).value).toMatchObject({ status: 'error', code: 'INVALID_OUTPUT' })
    h.subprocess.output = '  \n'
    expect((await h.call({ action: 'router_leases' })).value).toEqual({ action: 'router_leases', status: 'ok', rows: [], omittedRows: 0 })
  })

  it('redacts secrets-file values and credential shapes before the result is logged', async () => {
    const h = await harness()
    await writeFile(h.config.secretsPath, [
      '# comment', 'SHORTER=known-secret', 'OPNSENSE_API_KEY=known-secret-value', 'export CUB_KEY="quoted-secret"', "SINGLE='single-secret'",
      'SHORT=abc', 'EMPTY=', 'not a pair',
    ].join('\n'))
    h.subprocess.output = JSON.stringify([{
      item: 'probe', state: 'known-secret-value',
      detail: 'quoted-secret single-secret abc Bearer abc123 API_KEY=other https://u:p@example.com',
    }])
    const result = await h.call({ action: 'doctor' })
    const text = JSON.stringify(result.value)
    for (const value of ['known-secret', '-value', 'quoted-secret', 'single-secret', 'abc123', 'other', 'u:p']) expect(text).not.toContain(value)
    expect(result.value).toMatchObject({ rows: [{ state: '[REDACTED]' }] })
    expect(text).toContain(' abc Bearer [REDACTED]')
  })

  it('clips cells and drops trailing rows to the result cap', async () => {
    const h = await harness()
    h.subprocess.output = JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ item: `tool ${String(i)}`, state: 'ok', detail: 'x'.repeat(100) })))
    const result = await h.call({ action: 'doctor' })
    const value = JSON.parse(h.text(result)) as Homelab.HomelabResult
    expect(value.status).toBe('ok')
    expect(value.rows[0]?.detail).toBe('x'.repeat(64))
    expect(value.omittedRows).toBeGreaterThan(0)
    expect(value.rows.length + value.omittedRows).toBe(30)
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(1_024)
  })

  it('applies documented defaults and unregisters on disposal', async () => {
    const root = await beardyTree()
    const { ctx, subprocess } = await host()
    const full = configFor(root)
    const required: Homelab.Config = {
      bdyPath: full.bdyPath, secretsPath: full.secretsPath, allowedHosts: full.allowedHosts, allowedAgentPresets: full.allowedAgentPresets,
    }
    const fiber = await ctx.plugin({ name: 'direct-homelab', inject: Homelab.inject, apply: (inner: Context) => { Homelab.apply(inner, required) } })
    const agent = callerAgent(ctx, 'beardy')
    await ctx.tools.execute({ name: 'homelab', arguments: { action: 'doctor' }, callId: ToolCallId('defaults'), agent, signal: new AbortController().signal })
    expect(subprocess.specs[0]?.argv.slice(1, 4)).toEqual(['--json', '--timeout', '10'])
    expect(subprocess.specs[0]).toMatchObject({ graceMs: 1_000, stdio: { stdout: { maxBytes: 262_144 } } })
    await fiber.dispose()
    expect(ctx.tools.schemas().map(tool => tool.name)).not.toContain('homelab')
  })
})

describe('homelab deployment validation', () => {
  async function load(config: Homelab.Config): Promise<void> {
    const { ctx } = await host()
    Homelab.apply(ctx, config)
  }

  it.each<[string, (root: string) => Promise<Partial<Homelab.Config>>, string]>([
    ['a relative path', async () => ({ bdyPath: 'beardy/bin/bdy' }), 'absolute normalized'],
    ['another file name', async root => ({ bdyPath: join(root, 'bin', 'sh') }), 'absolute normalized'],
    ['a missing executable', async root => ({ bdyPath: join(root, 'other', 'bin', 'bdy') }), 'executable file'],
    ['a non-executable file', async (root) => { await chmod(join(root, 'bin', 'bdy'), 0o644); return {} }, 'executable file'],
    ['a directory', async (root) => {
      await mkdir(join(root, 'dir', 'bin', 'bdy'), { recursive: true })
      return { bdyPath: join(root, 'dir', 'bin', 'bdy') }
    }, 'executable file'],
    ['a symlink leaving the checkout', async (root) => {
      const other = await beardyTree()
      await mkdir(join(root, 'link', 'bin'), { recursive: true })
      await symlink(join(other, 'bin', 'bdy'), join(root, 'link', 'bin', 'bdy'))
      return { bdyPath: join(root, 'link', 'bin', 'bdy') }
    }, 'executable file'],
    ['a checkout without src/cli.ts', async (root) => { await rm(join(root, 'src', 'cli.ts')); return {} }, 'src/cli.ts'],
    ['a relative secrets path', async () => ({ secretsPath: 'secrets.env' }), 'secretsPath'],
    ['a flag-shaped host', async () => ({ allowedHosts: ['--yes'] }), 'allowedHosts'],
    ['a duplicate preset', async () => ({ allowedAgentPresets: ['beardy', 'beardy'] }), 'allowedAgentPresets'],
    ['an empty preset list', async () => ({ allowedAgentPresets: [] }), 'any or name at least one preset'],
    ['a host outside the inventory', async () => ({ allowedHosts: ['nas'] }), 'not inventory IDs: nas'],
    ['a fractional timeout', async () => ({ timeoutMs: 1_500.5 }), 'timeoutMs must be an integer'],
    ['an oversized result cap', async () => ({ maxResultBytes: 1_000_000 }), 'maxResultBytes'],
    ['a Beardy timeout at the tool deadline', async () => ({ timeoutMs: 2_000, bdyTimeoutSeconds: 2 }), 'shorter than timeoutMs'],
  ])('rejects %s at load', async (_label, mutate, message) => {
    const root = await beardyTree()
    const overrides = await mutate(root)
    await expect(load(configFor(root, overrides))).rejects.toThrow(message)
  })

  it.each([['missing', undefined], ['malformed', '{'], ['hostless', '{"subnet":"192.168.1.0/24"}'], ['non-object', '[]']])('rejects a %s inventory', async (_label, inventory) => {
    const root = await beardyTree(inventory ?? {})
    if (inventory === undefined) await rm(join(root, 'inventory', 'hosts.json'))
    await expect(load(configFor(root))).rejects.toThrow('inventory/hosts.json')
  })

  it('validates configuration through the exported schema', () => {
    const base = { bdyPath: '/b/bin/bdy', secretsPath: '/s', allowedHosts: [], allowedAgentPresets: ['beardy'] }
    expect(() => Homelab.Config({ ...base, timeoutMs: 1.5 })).toThrow()
    expect(() => Homelab.Config({ ...base, allowedAgentPresets: 'all' as never })).toThrow()
    expect(Homelab.Config({ ...base, allowedAgentPresets: 'any' })).toMatchObject({ allowedAgentPresets: 'any' })
    expect(Homelab.Config(base)).toMatchObject({
      timeoutMs: 30_000, bdyTimeoutSeconds: 10, graceMs: 1_000, maxStdoutBytes: 262_144, maxResultBytes: 16_384, maxCellChars: 256,
    })
  })
})
