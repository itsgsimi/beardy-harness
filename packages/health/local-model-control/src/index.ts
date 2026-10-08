/**
 * Host-owned human commands and durable intentional-unload state for fixed local model backends.
 * The control process receives only validated deployment targets, never model text.
 * @module @deepseek-ai/dsh-local-model-control
 */

import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, posix } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-agent'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import z from '@deepseek-ai/schemastery'
import { z as storageSchema } from 'zod'

/** Loader name for the Host controller. */
export const name = 'local-model-control'
/** The command and process providers are required when this row is enabled. */
export const inject = ['commands', 'subprocess']

/** One fixed deployment backend and its provider routes. */
export interface BackendConfig {
  /** Unique human-facing backend ID. */
  readonly name: string
  /** Local Docker or a remote halorun profile over SSH. */
  readonly kind: 'docker' | 'halorun'
  /** Docker container name for a Docker backend. */
  readonly container?: string
  /** Halorun profile name for a remote backend. */
  readonly profile?: string
  /** SSH user and host for a remote backend. */
  readonly sshTarget?: string
  /** Optional remote watchdog pause file for a halorun backend. */
  readonly holdFile?: string
  /** Exact provider route names blocked during intentional unload. */
  readonly routes: string[]
  /** HTTP endpoint checked after load and matched to a health probe. */
  readonly healthUrl?: string
  /** Maximum health wait after the load command succeeds, in milliseconds. */
  readonly loadTimeoutMs: number
}

/** Controller configuration; no backend exists by default. */
export interface Config {
  /** Absolute path to the durable intentional-unload state. */
  readonly stateFile: string
  /** Operator name recorded for successful unloads. */
  readonly operatorName: string
  /** Preset IDs permitted to run human control commands. */
  readonly allowedPresets: string[]
  /** Fixed backends with distinct names and provider routes. */
  readonly backends: BackendConfig[]
  /** Named commands mapped to configured backend IDs. */
  readonly groups?: Record<string, string[]>
  /** Maximum duration of a control subprocess, in milliseconds. */
  readonly commandTimeoutMs?: number
  /** Interval between load health checks, in milliseconds. */
  readonly healthPollMs?: number
  /** Termination grace for a timed-out subprocess, in milliseconds. */
  readonly graceMs?: number
}

/** Values after defaults and cross-field validation. */
export interface ResolvedConfig extends Config {
  readonly groups: Record<string, string[]>
  readonly commandTimeoutMs: number
  readonly healthPollMs: number
  readonly graceMs: number
}

/** Loader schema; cross-field and argv validation runs at mount. */
export const Config: z<Config> = z.object({
  stateFile: z.string().required(),
  operatorName: z.string().required(),
  allowedPresets: z.array(z.string()).required(),
  backends: z.array(z.object({
    name: z.string().required(),
    kind: z.union([z.const('docker'), z.const('halorun')]),
    container: z.string(),
    profile: z.string(),
    sshTarget: z.string(),
    holdFile: z.string(),
    routes: z.array(z.string()).required(),
    healthUrl: z.string(),
    loadTimeoutMs: z.number().min(1).required(),
  })).required(),
  groups: z.dict(z.array(z.string())).default({}),
  commandTimeoutMs: z.number().min(1).default(30_000),
  healthPollMs: z.number().min(1).default(1_000),
  graceMs: z.number().min(1).default(1_000),
})

const NAME = /^[a-z][a-z0-9-]*$/u
const TARGET = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u
const SSH_TARGET = /^[A-Za-z0-9][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9_.-]*$/u
const HOLD_FILE = /^(?:~\/|\/)(?:[A-Za-z0-9_-]|\.[A-Za-z0-9_-])[A-Za-z0-9._-]*(?:\/(?:[A-Za-z0-9_-]|\.[A-Za-z0-9_-])[A-Za-z0-9._-]*)*$/u
const MAX_TIMER = 2_147_483_647

/** Validate every target and resolve deployment-varying time bounds once.
 * @param raw - Loader configuration.
 * @returns Validated configuration with timer defaults.
 */
export function resolveConfig(raw: Config): ResolvedConfig {
  const config: ResolvedConfig = { stateFile: raw.stateFile, operatorName: raw.operatorName,
    allowedPresets: raw.allowedPresets, backends: raw.backends,
    groups: raw.groups ?? {},
    commandTimeoutMs: raw.commandTimeoutMs ?? 30_000,
    healthPollMs: raw.healthPollMs ?? 1_000,
    graceMs: raw.graceMs ?? 1_000,
  }
  if (!isAbsolute(config.stateFile)) throw new Error('local-model-control: stateFile must be absolute')
  if (config.operatorName.trim() === '') throw new Error('local-model-control: operatorName is empty')
  if (config.allowedPresets.length === 0 || config.allowedPresets.some(preset => !NAME.test(preset))
    || new Set(config.allowedPresets).size !== config.allowedPresets.length) {
    throw new Error('local-model-control: allowedPresets must be distinct preset IDs')
  }
  for (const [field, value] of Object.entries({ commandTimeoutMs: config.commandTimeoutMs,
    healthPollMs: config.healthPollMs, graceMs: config.graceMs })) {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER) {
      throw new Error(`local-model-control: ${field} must be a positive timer-range integer`)
    }
  }
  const names = new Set<string>()
  const routes = new Set<string>()
  const urls = new Set<string>()
  for (const backend of config.backends) {
    if (!NAME.test(backend.name) || names.has(backend.name)) {
      throw new Error(`local-model-control: invalid or duplicate backend "${backend.name}"`)
    }
    names.add(backend.name)
    if (backend.kind === 'docker') {
      if (backend.container === undefined || !TARGET.test(backend.container)
        || backend.profile !== undefined || backend.sshTarget !== undefined || backend.holdFile !== undefined) {
        throw new Error(`local-model-control: docker backend "${backend.name}" needs only a safe container`)
      }
    } else {
      if (backend.profile === undefined || !TARGET.test(backend.profile)
        || backend.sshTarget === undefined || !SSH_TARGET.test(backend.sshTarget)
        || backend.container !== undefined) {
        throw new Error(`local-model-control: halorun backend "${backend.name}" needs a safe profile and SSH target`)
      }
      if (backend.holdFile !== undefined && !HOLD_FILE.test(backend.holdFile)) {
        throw new Error(`local-model-control: halorun backend "${backend.name}" needs a safe holdFile path`)
      }
    }
    if (backend.routes.length === 0) throw new Error(`local-model-control: backend "${backend.name}" needs a provider route`)
    for (const route of backend.routes) {
      if (!NAME.test(route) || routes.has(route)) throw new Error(`local-model-control: invalid or duplicate provider route "${route}"`)
      routes.add(route)
    }
    if (!Number.isSafeInteger(backend.loadTimeoutMs) || backend.loadTimeoutMs < 1 || backend.loadTimeoutMs > MAX_TIMER) {
      throw new Error(`local-model-control: backend "${backend.name}" loadTimeoutMs must be a positive timer-range integer`)
    }
    if (backend.healthUrl !== undefined) {
      let url: URL
      try { url = new URL(backend.healthUrl) } catch { throw new Error(`local-model-control: backend "${backend.name}" has an invalid healthUrl`) }
      if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.hash !== ''
        || urls.has(backend.healthUrl)) {
        throw new Error(`local-model-control: backend "${backend.name}" needs a distinct HTTP healthUrl without credentials`)
      }
      urls.add(backend.healthUrl)
    }
  }
  for (const [group, members] of Object.entries(config.groups)) {
    if (!NAME.test(group) || group === 'models' || members.length === 0 || new Set(members).size !== members.length
      || members.some(member => !names.has(member))) {
      throw new Error(`local-model-control: group "${group}" must name distinct configured backends`)
    }
  }
  return config
}

/** Persisted operator action; a backend absent from this map is not intentionally unloaded. */
export interface UnloadIntent { readonly by: string; readonly at: string }
const intentsSchema = storageSchema.object({ version: storageSchema.literal(1),
  unloaded: storageSchema.record(storageSchema.string(), storageSchema.object({
    by: storageSchema.string().min(1), at: storageSchema.iso.datetime(),
  })) }).strict()

/** A read-only view used by health, Agent request admission, and cron. */
export interface LocalModelStatus {
  /** Find intentional unload for one exact provider route.
   * @param provider - Configured provider route.
   * @returns Backend and intent when that route is paused.
   */
  unloadedForRoute(provider: string): { backend: string; intent: UnloadIntent } | undefined
  /** Find intentional unload for one exact health endpoint.
   * @param url - Configured probe URL.
   * @returns Backend and intent when that probe is paused.
   */
  unloadedForHealthUrl(url: string): { backend: string; intent: UnloadIntent } | undefined
  /** List configured backends with any current intentional unload.
   * @returns Read-only backend status snapshots.
   */
  backends(): readonly { name: string; routes: readonly string[]; intent?: UnloadIntent }[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Intentional-unload state shared by Host consumers. */
    localModels: LocalModelStatus
  }
}

/** External operations replaceable by deterministic tests. */
export interface LocalModelDeps {
  readonly subprocess: Pick<SubprocessRuntime, 'spawn'>
  readonly fetch: typeof fetch
  readonly now: () => number
  readonly wait: (ms: number, signal: AbortSignal) => Promise<void>
}

/** Operator controller with serialized mutations and atomic state replacement. */
export class LocalModelController implements LocalModelStatus {
  private readonly unloaded = new Map<string, UnloadIntent>()
  private pending: Promise<unknown> = Promise.resolve()

  private constructor(private readonly config: ResolvedConfig, private readonly deps: LocalModelDeps) {}

  /** Read and validate the durable state before any route or command can use this service.
   * @param config - Validated controller configuration.
   * @param deps - Process, HTTP, and clock providers.
   * @returns Controller initialized from durable intent.
   */
  static async open(config: ResolvedConfig, deps: LocalModelDeps): Promise<LocalModelController> {
    const controller = new LocalModelController(config, deps)
    let text: string
    try { text = await readFile(config.stateFile, 'utf8') }
    catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return controller
      throw error
    }
    const persisted = intentsSchema.parse(JSON.parse(text))
    const names = new Set(config.backends.map(backend => backend.name))
    for (const [backend, intent] of Object.entries(persisted.unloaded)) {
      if (!names.has(backend)) throw new Error(`local-model-control: stateFile names unknown backend "${backend}"`)
      controller.unloaded.set(backend, intent)
    }
    return controller
  }

  unloadedForRoute(provider: string): { backend: string; intent: UnloadIntent } | undefined {
    const backend = this.config.backends.find(candidate => candidate.routes.includes(provider))
    const intent = backend === undefined ? undefined : this.unloaded.get(backend.name)
    return backend === undefined || intent === undefined ? undefined : { backend: backend.name, intent }
  }

  unloadedForHealthUrl(url: string): { backend: string; intent: UnloadIntent } | undefined {
    const backend = this.config.backends.find(candidate => candidate.healthUrl === url)
    const intent = backend === undefined ? undefined : this.unloaded.get(backend.name)
    return backend === undefined || intent === undefined ? undefined : { backend: backend.name, intent }
  }

  backends(): readonly { name: string; routes: readonly string[]; intent?: UnloadIntent }[] {
    return this.config.backends.map((backend) => {
      const intent = this.unloaded.get(backend.name)
      return { name: backend.name, routes: backend.routes, ...(intent === undefined ? {} : { intent }) }
    })
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation)
    this.pending = result.catch(() => undefined)
    return result
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.config.stateFile), { recursive: true, mode: 0o700 })
    const temporary = `${this.config.stateFile}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify({ version: 1, unloaded: Object.fromEntries(this.unloaded) }) + '\n')
    } finally { await file.close() }
    try { await rename(temporary, this.config.stateFile) }
    catch (error: unknown) { await rm(temporary, { force: true }); throw error }
  }

  private argv(backend: BackendConfig, action: 'load' | 'unload'): readonly string[] {
    if (backend.kind === 'docker') return ['docker', action === 'load' ? 'start' : 'stop', backend.container as string]
    return ['ssh', '-o', 'BatchMode=yes', '--', backend.sshTarget as string,
      'halorun', action === 'load' ? 'start' : 'stop', backend.profile as string]
  }

  private async runArgv(argv: readonly string[], label: string, signal: AbortSignal): Promise<void> {
    const deadline = AbortSignal.timeout(this.config.commandTimeoutMs)
    const combined = AbortSignal.any([signal, deadline])
    const spec: SubprocessSpawnSpec = { argv, cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
      graceMs: this.config.graceMs, signal: combined }
    const outcome = await this.deps.subprocess.spawn(spec).done
    if (deadline.aborted) throw new Error(`${label} command timed out after ${this.config.commandTimeoutMs}ms`)
    signal.throwIfAborted()
    if (outcome.exitCode !== 0 || outcome.signal !== null) {
      throw new Error(`${label} command exited ${String(outcome.exitCode)}${outcome.signal === null ? '' : ` (${outcome.signal})`}`)
    }
  }

  private async setHold(backend: BackendConfig, action: 'load' | 'unload', signal: AbortSignal): Promise<void> {
    if (backend.kind !== 'halorun' || backend.holdFile === undefined) return
    const ssh = ['ssh', '-o', 'BatchMode=yes', '--', backend.sshTarget as string]
    try {
      if (action === 'unload') {
        await this.runArgv([...ssh, 'mkdir', '-p', '--', posix.dirname(backend.holdFile)], 'watchdog hold', signal)
        await this.runArgv([...ssh, 'touch', '--', backend.holdFile], 'watchdog hold', signal)
      } else {
        await this.runArgv([...ssh, 'rm', '-f', '--', backend.holdFile], 'watchdog hold', signal)
      }
    } catch (error: unknown) {
      throw new Error(`watchdog hold ${action} failed: ${String(error)}`, { cause: error })
    }
  }

  private async waitHealthy(backend: BackendConfig, signal: AbortSignal): Promise<void> {
    if (backend.healthUrl === undefined) return
    const deadline = AbortSignal.timeout(backend.loadTimeoutMs)
    const combined = AbortSignal.any([signal, deadline])
    while (!combined.aborted) {
      try {
        const response = await this.deps.fetch(backend.healthUrl, { method: 'GET', signal: combined })
        const healthy = response.status === 200
        await response.body?.cancel()
        if (healthy) return
      } catch (error: unknown) {
        if (signal.aborted) throw error
      }
      try { await this.deps.wait(this.config.healthPollMs, combined) }
      catch (error: unknown) { if (signal.aborted) throw error }
    }
    signal.throwIfAborted()
    throw new Error(`health wait timed out after ${backend.loadTimeoutMs}ms`)
  }

  /** Run one fixed control action and persist its operator intent after success.
   * @param name - Configured backend ID.
   * @param action - Load or unload operation.
   * @param signal - Command cancellation signal.
   * @returns Human-readable action result.
   */
  async change(name: string, action: 'load' | 'unload', signal: AbortSignal): Promise<string> {
    return this.serialize(async () => {
      const backend = this.config.backends.find(candidate => candidate.name === name)
      if (backend === undefined) throw new Error(`unknown backend "${name}"`)
      signal.throwIfAborted()
      await this.setHold(backend, action, signal)
      await this.runArgv(this.argv(backend, action), 'control', signal)
      if (action === 'load') await this.waitHealthy(backend, signal)
      const previous = this.unloaded.get(name)
      if (action === 'unload') this.unloaded.set(name, { by: this.config.operatorName, at: new Date(this.deps.now()).toISOString() })
      else this.unloaded.delete(name)
      try { await this.persist() }
      catch (error: unknown) {
        if (action === 'load') {
          if (previous === undefined) this.unloaded.delete(name)
          else this.unloaded.set(name, previous)
        }
        throw error
      }
      return `${name}: ${action === 'load'
        ? backend.healthUrl === undefined ? 'loaded' : 'loaded and healthy'
        : `unloaded by ${this.config.operatorName}`}.`
    })
  }

  /** Execute a human command only from a configured, trusted Agent preset.
   * @param command - Registered command name.
   * @param rawInput - Human-supplied command arguments.
   * @param preset - Agent preset invoking the command.
   * @param signal - Command cancellation signal.
   * @returns Success text or a user-facing command error.
   */
  async command(command: string, rawInput: string, preset: string | undefined, signal: AbortSignal): Promise<CommandResult> {
    if (preset === undefined || !this.config.allowedPresets.includes(preset)) {
      return { kind: 'error', text: 'Local model controls are unavailable in this lane.' }
    }
    const args = rawInput.trim().split(/\s+/u)
    if (command === 'models') {
      if (args.length === 1 && args[0] === 'status') {
        return { kind: 'success', text: this.backends().map(backend => backend.intent === undefined
          ? `${backend.name}: available (${backend.routes.join(', ')}).`
          : `${backend.name}: unloaded by ${backend.intent.by} at ${backend.intent.at} (${backend.routes.join(', ')}).`).join('\n')
          || 'No local model backends configured.' }
      }
      if (args.length === 2 && (args[0] === 'load' || args[0] === 'unload')) {
        try { return { kind: 'success', text: await this.change(args[1] as string, args[0], signal) } }
        catch (error: unknown) { return { kind: 'error', text: `Local model ${args[0]} failed: ${error instanceof Error ? error.message : 'unknown error'}` } }
      }
      return { kind: 'error', text: 'Usage: /models status | load <name> | unload <name>' }
    }
    const members = this.config.groups[command]
    if (members === undefined || args.length !== 1 || (args[0] !== 'on' && args[0] !== 'off')) {
      return { kind: 'error', text: `Usage: /${command} on | off` }
    }
    const action = args[0] === 'on' ? 'unload' : 'load'
    const reports: string[] = []
    for (const member of members) {
      try { reports.push(await this.change(member, action, signal)) }
      catch (error: unknown) {
        return { kind: 'error', text: `${reports.join('\n')}${reports.length === 0 ? '' : '\n'}${member}: ${error instanceof Error ? error.message : 'unknown error'}` }
      }
    }
    return { kind: 'success', text: reports.join('\n') }
  }

  /** Register `/models` and one human command per configured group.
   * @param ctx - Host context owning registration effects.
   */
  registerCommands(ctx: Context): void {
    ctx.effect(() => {
      const disposers = [ctx.commands.register({ name: 'models', description: 'Show or control configured local model backends.',
        input: { hint: 'status | load <name> | unload <name>' },
        handler: invocation => this.command('models', invocation.rawInput, invocation.agent.session.header.agentPreset, invocation.signal) })]
      for (const group of Object.keys(this.config.groups)) {
        disposers.push(ctx.commands.register({ name: group, description: `Switch the ${group} local model group.`,
          input: { hint: 'on | off' },
          handler: invocation => this.command(group, invocation.rawInput,
            invocation.agent.session.header.agentPreset, invocation.signal) }))
      }
      return () => { for (const dispose of disposers.reverse()) dispose() }
    }, 'local model human commands')
  }
}

/**
 * Fail every Agent model request whose final provider route is intentionally unloaded with
 * `LOCAL_MODEL_UNLOADED`, before the request header is logged or the adapter receives the call.
 * The listener is prepended so it reads the route after every other `agent/request` listener has
 * replaced it. Direct `ctx.llm` callers outside an Agent turn are not checked.
 * @param ctx - Host context owning the listener.
 * @param status - Intentional-unload state to read on each request.
 */
export function installRouteAdmission(ctx: Context, status: LocalModelStatus): void {
  ctx.on('agent/request', async (_payload, next) => {
    const config = await next()
    const paused = status.unloadedForRoute(config.provider)
    if (paused !== undefined) {
      throw new LlmError(`local model unloaded: ${paused.backend} was unloaded by ${paused.intent.by} at ${paused.intent.at}`, 'LOCAL_MODEL_UNLOADED')
    }
    return config
  }, { prepend: true })
}

/** Load durable intent before publishing status, admitting Agent requests, or accepting commands. */
export async function apply(ctx: Context, raw: Config): Promise<void> {
  const config = resolveConfig(raw)
  const controller = await LocalModelController.open(config, {
    subprocess: ctx.subprocess, fetch: globalThis.fetch, now: Date.now,
    wait: (ms, signal) => delay(ms, undefined, { signal }),
  })
  ctx.provide('localModels', controller)
  installRouteAdmission(ctx, controller)
  controller.registerCommands(ctx)
}
