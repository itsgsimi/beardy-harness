/**
 * Fixed read-only Beardy observations as the `homelab` model tool. The plugin owns
 * caller authorization, argv selection, result projection, redaction, and result
 * bounds; each call and its rendered result enter the Session log.
 * @module @deepseek-ai/dsh-tool-homelab
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-session-projection'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SubprocessOutcome, SubprocessOutputRead, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/** Cordis Loader name. */
export const name = 'tool-homelab'
/** The model tool registry, a subprocess provider, and Session projections for the caller's preset. */
export const inject = ['tools', 'subprocess', 'sessionProjections']

/** Beardy observations the model may request. Each one maps to a fixed argv template. */
export const HOMELAB_ACTIONS = [
  'hosts', 'discover', 'dns', 'disk', 'docker_status', 'firewall_rules', 'router_leases', 'net_top', 'doctor',
] as const

/** One Beardy observation name. */
export type HomelabAction = typeof HOMELAB_ACTIONS[number]

/** Fixed failure reasons; Beardy stderr never reaches a result. */
export type HomelabFailureCode = 'BDY_EXIT' | 'TIMEOUT' | 'SPAWN_FAILED' | 'STDOUT_CAP' | 'INVALID_OUTPUT' | 'SECRETS_UNREADABLE'

const FAILURE_CODES: readonly HomelabFailureCode[] = ['BDY_EXIT', 'TIMEOUT', 'SPAWN_FAILED', 'STDOUT_CAP', 'INVALID_OUTPUT', 'SECRETS_UNREADABLE']

/** One projected Beardy row: selected columns only, every string redacted and clipped. */
export type HomelabRow = Record<string, string | number | boolean | null>

/** Canonical `homelab` tool value. */
export interface HomelabResult {
  /** Observation that ran. */
  action: HomelabAction
  /** `ok` for exit 0 with parsed rows; `error` and `timeout` carry a fixed `code`. */
  status: 'ok' | 'error' | 'timeout'
  /** Fixed failure reason, present unless `status` is `ok`. */
  code?: HomelabFailureCode
  /** Beardy exit code for `BDY_EXIT`; `null` when a signal ended the process. */
  exitCode?: number | null
  /** Projected rows; Beardy may print rows before a nonzero exit, such as for an unreachable disk host. */
  rows: HomelabRow[]
  /** Trailing rows dropped to keep the serialized value within `maxResultBytes`. */
  omittedRows: number
}

/** Deployment-owned executable, authority, and resource limits. */
export interface Config {
  /** Absolute path of `bin/bdy` inside a Beardy checkout. */
  bdyPath: string
  /** Absolute path of Beardy's secrets file; forwarded as `BDY_SECRETS_FILE` and used for exact-value redaction. */
  secretsPath: string
  /** Inventory host IDs `docker_status` may name; an empty list removes that action. */
  allowedHosts: string[]
  /** Agent presets whose Sessions may run the tool, or `any` for every caller; others fail before a process starts. */
  allowedAgentPresets: 'any' | string[]
  /** Wall-clock deadline for one Beardy call in milliseconds. */
  timeoutMs?: number
  /** Beardy's own per-operation `--timeout` in seconds; must stay below `timeoutMs`. */
  bdyTimeoutSeconds?: number
  /** Grace period for the subprocess provider's termination procedure in milliseconds. */
  graceMs?: number
  /** In-memory stdout cap; a larger stream yields `STDOUT_CAP` instead of partial JSON. */
  maxStdoutBytes?: number
  /** Serialized result cap; trailing rows are dropped and counted in `omittedRows`. */
  maxResultBytes?: number
  /** Per-cell character cap applied after redaction. */
  maxCellChars?: number
}

const LIMITS = {
  timeoutMs: { min: 1_000, max: 300_000, default: 30_000 },
  bdyTimeoutSeconds: { min: 1, max: 120, default: 10 },
  graceMs: { min: 1, max: 30_000, default: 1_000 },
  maxStdoutBytes: { min: 4_096, max: 4_194_304, default: 262_144 },
  maxResultBytes: { min: 1_024, max: 65_536, default: 16_384 },
  maxCellChars: { min: 16, max: 4_096, default: 256 },
} as const

type LimitName = keyof typeof LIMITS

function limitSchema(key: LimitName): z<number> {
  const { min, max, default: value } = LIMITS[key]
  return z.natural().min(min).max(max).default(value)
}

/** Validated deployment configuration. */
export const Config: z<Config> = z.object({
  bdyPath: z.string().required(),
  secretsPath: z.string().required(),
  allowedHosts: z.array(z.string()).required(),
  allowedAgentPresets: z.union([z.const('any'), z.array(z.string())]).required(),
  timeoutMs: limitSchema('timeoutMs'),
  bdyTimeoutSeconds: limitSchema('bdyTimeoutSeconds'),
  graceMs: limitSchema('graceMs'),
  maxStdoutBytes: limitSchema('maxStdoutBytes'),
  maxResultBytes: limitSchema('maxResultBytes'),
  maxCellChars: limitSchema('maxCellChars'),
})

type ResolvedConfig = Readonly<Record<LimitName, number> & {
  bdyPath: string
  secretsPath: string
  beardyRoot: string
  allowedHosts: readonly string[]
  allowedAgentPresets: ReadonlySet<string> | 'any'
}>

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
// The discard buffer only keeps Beardy diagnostics from blocking the pipe; its text is never read.
const STDERR_DISCARD_BYTES = 1_024
// Docker's full JSON carries unbounded labels, mounts, and networks; this template keeps five fields.
// Beardy classifies `docker ps` as a read, so it never asks for approval.
const DOCKER_FORMAT = '{"Names":{{json .Names}},"Image":{{json .Image}},"State":{{json .State}},"Status":{{json .Status}},"Ports":{{json .Ports}}}'

const COLUMNS: Readonly<Record<HomelabAction, readonly string[]>> = {
  hosts: ['id', 'addr', 'user', 'role', 'tags'],
  discover: ['ip', 'name', 'ping', 'ssh', 'known', 'services', 'mac'],
  dns: ['resolver', 'rcode', 'answer', 'ms', 'flag'],
  disk: ['host', 'mount', 'type', 'size', 'used', 'avail', 'use', 'note'],
  docker_status: ['Names', 'Image', 'State', 'Status', 'Ports'],
  firewall_rules: ['seq', 'sort', 'on', 'act', 'ip', 'src', 'dst', 'q', 'desc', 'uuid'],
  router_leases: ['ip', 'mac', 'hostname', 'vendor', 'iface', 'until', 'type'],
  net_top: ['rank', 'ip', 'name', 'via', 'vendor', 'mbps_avg', 'total'],
  doctor: ['item', 'state', 'detail'],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function limitValue(config: Config, key: LimitName): number {
  const { min, max, default: fallback } = LIMITS[key]
  const value = config[key] ?? fallback
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`tool-homelab: ${key} must be an integer from ${String(min)} through ${String(max)}`)
  }
  return value
}

function assertIdentifiers(values: readonly string[], field: string): void {
  if (!values.every(value => IDENTIFIER.test(value)) || new Set(values).size !== values.length) {
    throw new Error(`tool-homelab: ${field} must contain unique identifiers`)
  }
}

function inventoryIds(path: string): Set<string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // Missing, unreadable, and malformed inventories are one load failure; no host list is guessed.
    throw new Error('tool-homelab: inventory/hosts.json must be readable JSON')
  }
  const hosts = isRecord(parsed) ? parsed.hosts : undefined
  if (!Array.isArray(hosts)) throw new Error('tool-homelab: inventory/hosts.json must contain a hosts array')
  return new Set(hosts.flatMap(host => isRecord(host) && typeof host.id === 'string' ? [host.id] : []))
}

function resolveConfig(config: Config): ResolvedConfig {
  const path = config.bdyPath
  if (!isAbsolute(path) || normalize(path) !== path || basename(path) !== 'bdy' || basename(dirname(path)) !== 'bin') {
    throw new Error('tool-homelab: bdyPath must be an absolute normalized .../bin/bdy path')
  }
  const beardyRoot = dirname(dirname(path))
  if (!existsSync(path) || realpathSync(path) !== join(realpathSync(beardyRoot), 'bin', 'bdy')
    || !statSync(path).isFile() || (statSync(path).mode & 0o111) === 0) {
    throw new Error('tool-homelab: bdyPath must be an executable file inside its Beardy checkout')
  }
  if (!existsSync(join(beardyRoot, 'src', 'cli.ts'))) throw new Error('tool-homelab: the Beardy checkout must contain src/cli.ts')
  if (!isAbsolute(config.secretsPath) || normalize(config.secretsPath) !== config.secretsPath) {
    throw new Error('tool-homelab: secretsPath must be an absolute normalized path')
  }
  assertIdentifiers(config.allowedHosts, 'allowedHosts')
  const presets = config.allowedAgentPresets
  if (presets !== 'any') {
    assertIdentifiers(presets, 'allowedAgentPresets')
    if (presets.length === 0) throw new Error('tool-homelab: allowedAgentPresets must be any or name at least one preset')
  }
  const inventory = inventoryIds(join(beardyRoot, 'inventory', 'hosts.json'))
  const unknown = config.allowedHosts.filter(host => !inventory.has(host))
  if (unknown.length > 0) throw new Error(`tool-homelab: allowedHosts are not inventory IDs: ${unknown.join(', ')}`)
  const limits = Object.fromEntries((Object.keys(LIMITS) as LimitName[])
    .map(key => [key, limitValue(config, key)])) as Record<LimitName, number>
  if (limits.bdyTimeoutSeconds * 1_000 >= limits.timeoutMs) {
    throw new Error('tool-homelab: bdyTimeoutSeconds must be shorter than timeoutMs')
  }
  return {
    ...limits, bdyPath: path, secretsPath: config.secretsPath, beardyRoot,
    allowedHosts: [...config.allowedHosts], allowedAgentPresets: presets === 'any' ? presets : new Set(presets),
  }
}

// Every argv is fixed; docker_status alone inserts one allowlisted inventory host ID.
const COMMANDS: Readonly<Record<Exclude<HomelabAction, 'docker_status'>, readonly string[]>> = {
  hosts: ['hosts', 'list', '--no-probe'],
  discover: ['discover', '--no-ping'],
  dns: ['dns', '--resolvers'],
  disk: ['disk'],
  firewall_rules: ['fw', 'rules'],
  router_leases: ['router', 'leases'],
  net_top: ['net', 'talkers', '--window', '1h', '--limit', '10'],
  doctor: ['doctor'],
}

function commandArgs(action: HomelabAction, host: string | undefined): readonly string[] {
  return action === 'docker_status' ? ['docker', host as string, 'ps', '--all', '--format', DOCKER_FORMAT] : COMMANDS[action]
}

function parseSecretValues(text: string): string[] {
  return text.split('\n').flatMap((line) => {
    const match = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(.*)$/.exec(line.trim())
    if (match === null) return []
    const raw = (match[1] as string).trim()
    const quoted = raw.length >= 2 && (raw.startsWith('"') && raw.endsWith('"') || raw.startsWith("'") && raw.endsWith("'"))
    const value = quoted ? raw.slice(1, -1) : raw
    return value.length >= 4 ? [value] : []
  })
}

function readSecretValues(path: string): string[] | undefined {
  if (!existsSync(path)) return []
  try {
    return parseSecretValues(readFileSync(path, 'utf8'))
  } catch {
    // An existing but unreadable secrets file fails the call closed; no unredacted row leaves.
    return undefined
  }
}

function redact(value: string, secrets: readonly string[]): string {
  let text = value
  // Longest first, so a secret containing a shorter one is never left partly visible.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]')
  return text
    .replace(/\b(Bearer\s+)[a-z0-9._~+/-]+/gi, '$1[REDACTED]')
    .replace(/\b([a-z0-9_-]*(?:token|secret|password|api_key)[a-z0-9_-]*\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
}

function cell(value: unknown, secrets: readonly string[], maxChars: number): string | number | boolean | null {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  const text = typeof value === 'string' ? value
    : Array.isArray(value) && value.every(item => typeof item === 'string') ? value.join(',')
      : JSON.stringify(value)
  return redact(text, secrets).slice(0, maxChars)
}

function parseRows(action: HomelabAction, stdout: string, secrets: readonly string[], maxCellChars: number): HomelabRow[] {
  const decoded: unknown = stdout.trim() === '' ? []
    : action === 'docker_status'
      ? stdout.split('\n').filter(line => line.trim() !== '').map((line): unknown => JSON.parse(line))
      : JSON.parse(stdout)
  if (!Array.isArray(decoded) || !decoded.every(isRecord)) throw new Error('homelab: Beardy did not print a row array')
  return decoded.map((source) => {
    const row: HomelabRow = {}
    for (const key of COLUMNS[action]) if (source[key] !== undefined) row[key] = cell(source[key], secrets, maxCellChars)
    return row
  })
}

function bound(result: HomelabResult, maxBytes: number): HomelabResult {
  while (result.rows.length > 0 && Buffer.byteLength(JSON.stringify(result), 'utf8') > maxBytes) {
    result.rows.pop()
    result.omittedRows++
  }
  return result
}

function failure(action: HomelabAction, status: 'error' | 'timeout', code: HomelabFailureCode): HomelabResult {
  return { action, status, code, rows: [], omittedRows: 0 }
}

/**
 * The caller's current preset: the registry's projection when it is composed, else the creation header.
 * @param ctx - context providing Session projections.
 * @param agent - calling Agent, absent for Host-originated calls.
 * @returns the preset identity, or undefined when the Session has none.
 */
function callerPreset(ctx: Context, agent: Agent | undefined): string | undefined {
  if (agent === undefined) return undefined
  const projected = ctx.sessionProjections.stateOf(agent.session, 'agentPreset')
  return projected === undefined ? agent.session.header.agentPreset : projected ?? undefined
}

interface BdyRun {
  readonly outcome: SubprocessOutcome
  readonly stdout: SubprocessOutputRead | undefined
}

async function runBdy(ctx: Context, spec: SubprocessSpawnSpec): Promise<BdyRun | undefined> {
  try {
    const handle = ctx.subprocess.spawn(spec)
    return { outcome: await handle.done, stdout: handle.collected.stdout?.readFrom(0) }
  } catch {
    // Provider refusals and spawn failures are reported by the fixed SPAWN_FAILED code.
    return undefined
  }
}

/**
 * Register the `homelab` tool; invalid deployment settings fail at load.
 * @param ctx - plugin context providing `tools` and `subprocess`.
 * @param config - validated deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const docker = resolved.allowedHosts.length > 0
  const actions = HOMELAB_ACTIONS.filter(action => docker || action !== 'docker_status')
  const hostParameter = docker ? {
    host: {
      type: 'string' as const, enum: resolved.allowedHosts,
      description: 'Inventory host ID; required for docker_status and rejected otherwise.',
    },
  } : {}
  ctx.tools.register(defineTool({
    name: 'homelab',
    description: 'Read-only home-lab observations from the Beardy CLI. Actions: hosts (inventory), '
      + 'discover (LAN neighbors with names, common open ports, and MACs), dns (resolver liveness), '
      + 'disk (mount usage per inventory host), '
      + (docker ? 'docker_status (all containers on one host; requires host), ' : '')
      + 'firewall_rules (managed OPNsense rules), router_leases (DHCP leases), '
      + 'net_top (top 10 traffic sources over the last hour), doctor (Beardy environment checks). '
      + 'Returns projected JSON rows with fixed failure codes. This tool cannot change anything.',
    parameters: {
      action: { type: 'string', required: true, enum: actions },
      ...hostParameter,
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false, properties: {
          action: { type: 'string', required: true, enum: HOMELAB_ACTIONS },
          status: { type: 'string', required: true, enum: ['ok', 'error', 'timeout'] },
          code: { type: 'string', enum: FAILURE_CODES },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          rows: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          omittedRows: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: args => ({ card: 'generic', title: 'Home lab', kind: 'read', rawInput: JSON.stringify(args) }),
    async execute(args, exec): Promise<HomelabResult> {
      const allowed = resolved.allowedAgentPresets
      if (allowed !== 'any') {
        const preset = callerPreset(ctx, exec.agent)
        if (preset === undefined || !allowed.has(preset)) throw new Error('homelab: this agent preset may not read home-lab data')
      }
      const input: Record<string, unknown> = args
      const extra = Object.keys(input).filter(key => key !== 'action' && key !== 'host')
      if (extra.length > 0) throw new Error(`homelab: unsupported arguments: ${extra.join(', ')}`)
      const action = input.action as HomelabAction
      const host = typeof input.host === 'string' ? input.host : undefined
      if ((action === 'docker_status') !== (host !== undefined)) {
        throw new Error('homelab: host is required for docker_status and accepted only there')
      }
      const deadline = AbortSignal.timeout(resolved.timeoutMs)
      const run = await runBdy(ctx, {
        argv: [resolved.bdyPath, '--json', '--timeout', String(resolved.bdyTimeoutSeconds), ...commandArgs(action, host)],
        cwd: resolved.beardyRoot,
        stdio: { stdin: 'ignore', stdout: { maxBytes: resolved.maxStdoutBytes }, stderr: { maxBytes: STDERR_DISCARD_BYTES } },
        graceMs: resolved.graceMs,
        signal: AbortSignal.any([exec.signal, deadline]),
        env: { BDY_SECRETS_FILE: resolved.secretsPath },
      })
      exec.signal.throwIfAborted()
      if (deadline.aborted) return failure(action, 'timeout', 'TIMEOUT')
      if (run === undefined) return failure(action, 'error', 'SPAWN_FAILED')
      if (run.stdout === undefined || run.stdout.lossy) return failure(action, 'error', 'STDOUT_CAP')
      const secrets = readSecretValues(resolved.secretsPath)
      if (secrets === undefined) return failure(action, 'error', 'SECRETS_UNREADABLE')
      const exit = run.outcome.exitCode === 0 && run.outcome.signal === null
        ? undefined : { code: 'BDY_EXIT' as const, exitCode: run.outcome.exitCode }
      let rows: HomelabRow[]
      try {
        rows = parseRows(action, run.stdout.text, secrets, resolved.maxCellChars)
      } catch {
        // Malformed Beardy output is reported by code; its text never reaches the result.
        return { ...failure(action, 'error', 'INVALID_OUTPUT'), ...exit }
      }
      return bound({ action, status: exit === undefined ? 'ok' : 'error', ...exit, rows, omittedRows: 0 }, resolved.maxResultBytes)
    },
  }))
}
