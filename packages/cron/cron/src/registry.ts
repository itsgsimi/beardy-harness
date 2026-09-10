/**
 * The job registry: one view over configured jobs and durably stored runtime-created jobs, with
 * the guardrails that bound what a model may create and the continuity state every job carries.
 * Scheduling and delivery read from here; mutations land in the storage domain and re-plan the
 * timers through the `domain/changed` event.
 * @module @deepseek-ai/dsh-cron/registry
 */

import { isAbsolute, resolve as resolvePath } from 'node:path'
import { Cron } from 'croner'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { assertSchedule } from './schedule.ts'
import type { CronJobSpec, CronRunFinished, CronRunResult } from './types.ts'
import type { ActiveRunRecord, JobStateRecord, RunHistoryEntry, StoredJobRecord } from './domain.ts'

/** Bounds a runtime-created job must satisfy; every field is validated plugin configuration. */
export interface JobGuardrails {
  /** Agent presets a stored job may name; an empty list refuses creation. */
  readonly allowedAgentPresets: readonly string[]
  /** Permission presets a stored job may name; an empty list refuses creation. */
  readonly allowedPermissionPresets: readonly string[]
  /** Absolute roots a stored job's workspace path must sit inside. */
  readonly allowedWorkspaceRoots: readonly string[]
  /** Most jobs the store may hold. */
  readonly maxStoredJobs: number
  /** Two consecutive fires of a new schedule must be at least this far apart, in milliseconds. */
  readonly minIntervalMs: number
  /** Character cap for one job's continuity notes. */
  readonly notesMaxChars: number
}

/** One job as the scheduler sees it: definition, origin, arm state, and delivery target. */
export interface RegistryJob extends CronJobSpec {
  /** Where this definition came from. */
  readonly origin: 'config' | 'stored'
  /** Whether the schedule is armed; paused jobs keep their definition and never fire. */
  readonly enabled: boolean
  /** Channel a finished run's text should reach; absent means no channel delivery. */
  readonly deliverChannelId?: string
}

/** One job as listings show it: the registry view plus continuity state. */
export interface JobListing extends RegistryJob {
  /** Continuity notes carried into every fire. */
  readonly notes: string
  /** Most recent runs first, bounded by the history cap. */
  readonly lastRuns: readonly RunHistoryEntry[]
}

/** Fields `create` accepts for a new stored job. */
export interface CreateJobInput extends CronJobSpec {
  /** Channel delivery target; absent means none. */
  readonly deliverChannelId?: string
  /** Session id of the creating agent, when one created it. */
  readonly createdBy?: string
}

/** Partial definition `update` may patch onto a stored job. */
export interface UpdateJobPatch {
  readonly expression?: string
  readonly timezone?: string
  readonly prompt?: string
  readonly agentPreset?: string
  readonly permissionPreset?: string
  readonly workspacePath?: string
  readonly title?: string
  /** Replace the delivery channel; an empty string removes channel delivery. */
  readonly deliverChannelId?: string
}

/** The merged job view the plugin schedules, lists, and mutates. */
export interface JobRegistry {
  /** Every job, configured and stored, with continuity state; sorted by name. */
  list(): JobListing[]
  /** Armed jobs the scheduler should hold timers for. */
  scheduled(): RegistryJob[]
  /** One job by name, or undefined when nothing carries that name. */
  find(name: string): JobListing | undefined
  /** Create a stored job after every guardrail check. */
  create(input: CreateJobInput): Promise<RegistryJob>
  /** Patch a stored job; configured jobs refuse every change. */
  update(name: string, patch: UpdateJobPatch): Promise<RegistryJob>
  /** Remove a stored job and its continuity state; configured jobs refuse. */
  remove(name: string): Promise<void>
  /** Arm or pause a job of either origin; only its definition stays read-only for configured jobs. */
  setEnabled(name: string, enabled: boolean): Promise<RegistryJob>
  /** Replace a job's continuity notes; works for configured and stored jobs alike. */
  setNotes(name: string, notes: string): Promise<void>
  /** Persist a run reservation before its Session opens; pending outcomes must be delivered first. */
  beginRun(name: string, run: ActiveRunRecord): Promise<void>
  /** Store the terminal outcome and its pending delivery in the same durable write. */
  settleRun(name: string, result: CronRunResult, keepHistory: number): Promise<CronRunFinished>
  /** Pending delivery for one job, or undefined after its handoff was acknowledged. */
  pendingOutcome(name: string): CronRunFinished | undefined
  /** Clear a delivered outcome only when it still names the acknowledged Session. */
  acknowledgeOutcome(name: string, sessionId: string): Promise<void>
  /** Mark uncompleted reservations interrupted and return all outcomes awaiting delivery. */
  recoverRuns(keepHistory: number): Promise<CronRunFinished[]>
}

/** The definition fields every guardrail check reads. */
type GuardrailFields = Pick<CronJobSpec, 'name' | 'expression' | 'timezone' | 'prompt' | 'agentPreset' | 'permissionPreset' | 'workspacePath'>

/** Dependencies of one registry over the opened domain tables. */
export interface JobRegistryDeps {
  /** Jobs from plugin configuration; read-only members of the view. */
  readonly configJobs: readonly CronJobSpec[]
  /** Where each configured job delivers its finished text, if anywhere. */
  readonly configDelivery: ReadonlyMap<string, string>
  /** Durable stored-job definitions. */
  readonly jobsTable: KvTable<string, StoredJobRecord>
  /** Durable per-job continuity state. */
  readonly stateTable: KvTable<string, JobStateRecord>
  /** Bounds every create and update must satisfy. */
  readonly guardrails: JobGuardrails
}

function registryError(message: string): never {
  throw new Error(`dsh-cron: ${message}`)
}

function finishedPayload(name: string, pending: NonNullable<JobStateRecord['pendingOutcome']>): CronRunFinished {
  const { deliverChannelId, ...result } = pending
  return { jobName: name, ...result, ...(deliverChannelId === undefined ? {} : { deliverChannelId }) }
}

/**
 * Whether `path` equals `root` or sits inside it, on resolved absolute paths.
 * @param root - Allowed workspace root.
 * @param path - Candidate workspace path.
 * @returns Whether the resolved candidate equals or descends from the resolved root.
 */
export function isInsideRoot(root: string, path: string): boolean {
  const base = resolvePath(root)
  const target = resolvePath(path)
  const prefix = base.endsWith('/') ? base : `${base}/`
  return target === base || target.startsWith(prefix)
}

/**
 * Gap between the next two fires of one schedule after `from`.
 * @param expression - Cron expression to probe.
 * @param timezone - IANA timezone to evaluate it in.
 * @param from - Instant the probe starts at.
 * @returns Milliseconds between the first and second upcoming fire, or Infinity when fewer than
 * two fires remain.
 */
export function nextFireGap(expression: string, timezone: string, from: Date): number {
  const probe = new Cron(expression, { timezone, paused: true })
  const first = probe.nextRun(from)
  if (first === null) return Number.POSITIVE_INFINITY
  const second = probe.nextRun(first)
  if (second === null) return Number.POSITIVE_INFINITY
  return second.getTime() - first.getTime()
}

/**
 * Build the merged registry over configuration and the opened domain tables. A stored record that
 * collides with a configured job name throws at construction, naming both origins.
 * @param deps - configured jobs, delivery map, durable tables, and guardrails.
 * @returns the registry view and its mutations.
 */
export function createJobRegistry(deps: JobRegistryDeps): JobRegistry {
  const stateOf = (name: string): JobStateRecord => deps.stateTable.get(name) ?? { notes: '', lastRuns: [] }
  let stateWrites: Promise<unknown> = Promise.resolve()
  const changeState = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = stateWrites.then(operation)
    // The caller observes write failures; later notes and recovery writes must still run.
    stateWrites = result.catch(() => {})
    return result
  }

  const fromConfig = (job: CronJobSpec): RegistryJob => {
    const channel = deps.configDelivery.get(job.name)
    return {
      ...job,
      origin: 'config',
      enabled: stateOf(job.name).enabled ?? true,
      ...(channel === undefined ? {} : { deliverChannelId: channel }),
    }
  }
  const fromStored = (record: StoredJobRecord): RegistryJob => ({
    name: record.name,
    expression: record.expression,
    timezone: record.timezone,
    prompt: record.prompt,
    agentPreset: record.agentPreset,
    permissionPreset: record.permissionPreset,
    workspacePath: record.workspacePath,
    ...(record.title === undefined ? {} : { title: record.title }),
    origin: 'stored',
    enabled: stateOf(record.name).enabled ?? record.enabled,
    ...(record.deliver.kind === 'channel' ? { deliverChannelId: record.deliver.channelId } : {}),
  })

  const stored = (): StoredJobRecord[] => [...deps.jobsTable.entries()].map(([, value]) => value)
  const all = (): RegistryJob[] => [...deps.configJobs.map(fromConfig), ...stored().map(fromStored)]
  const isConfigured = (name: string): boolean => deps.configJobs.some(job => job.name === name)

  for (const record of stored()) {
    if (isConfigured(record.name)) {
      registryError(`job name "${record.name}" collides: configured and stored at once`)
    }
  }

  /** Run every definition-level guardrail a create or update must satisfy. */
  function assertAllowed(job: GuardrailFields, isCreate: boolean): void {
    if (!deps.guardrails.allowedAgentPresets.includes(job.agentPreset)) {
      registryError(`agent preset "${job.agentPreset}" is not allowed for stored jobs; allowed: `
        + `[${deps.guardrails.allowedAgentPresets.join(', ')}]`)
    }
    if (!deps.guardrails.allowedPermissionPresets.includes(job.permissionPreset)) {
      registryError(`permission preset "${job.permissionPreset}" is not allowed for stored jobs; allowed: `
        + `[${deps.guardrails.allowedPermissionPresets.join(', ')}]`)
    }
    if (!isAbsolute(job.workspacePath)
      || !deps.guardrails.allowedWorkspaceRoots.some(root => isInsideRoot(root, job.workspacePath))) {
      registryError(`workspace "${job.workspacePath}" is outside every allowedWorkspaceRoot: `
        + `[${deps.guardrails.allowedWorkspaceRoots.join(', ')}]`)
    }
    try {
      assertSchedule(job.expression, job.timezone)
    } catch (error: unknown) {
      registryError(`schedule "${job.expression}" (${job.timezone}) is unusable: ${String(error)}`)
    }
    if (nextFireGap(job.expression, job.timezone, new Date()) < deps.guardrails.minIntervalMs) {
      registryError(`schedule "${job.expression}" (${job.timezone}) fires more often than every `
        + `${String(deps.guardrails.minIntervalMs)}ms, below minIntervalMs`)
    }
    if (isCreate && stored().length >= deps.guardrails.maxStoredJobs) {
      registryError(`the store already holds its ${String(deps.guardrails.maxStoredJobs)} jobs; delete one first`)
    }
  }

  function requireStored(name: string, action: string): StoredJobRecord {
    const record = deps.jobsTable.get(name)
    if (record === undefined) {
      if (isConfigured(name)) {
        registryError(`job "${name}" comes from configuration; ${action} applies to stored jobs only`)
      }
      registryError(`no job named "${name}"`)
    }
    return record
  }

  const registry: JobRegistry = {
    list(): JobListing[] {
      return all()
        .map((job) => {
          const state = stateOf(job.name)
          return { ...job, ...state, enabled: state.enabled ?? job.enabled }
        })
        .sort((left, right) => left.name.localeCompare(right.name))
    },
    scheduled(): RegistryJob[] {
      return all().filter(job => job.enabled)
    },
    find(name: string): JobListing | undefined {
      const job = all().find(job => job.name === name)
      if (job === undefined) return undefined
      const state = stateOf(name)
      return { ...job, ...state, enabled: state.enabled ?? job.enabled }
    },
    async create(input: CreateJobInput): Promise<RegistryJob> {
      if (isConfigured(input.name)) {
        registryError(`job name "${input.name}" is taken by a configured job`)
      }
      if (deps.jobsTable.get(input.name) !== undefined) {
        registryError(`job name "${input.name}" already exists; update it instead`)
      }
      assertAllowed(input, true)
      const record: StoredJobRecord = {
        name: input.name,
        expression: input.expression,
        timezone: input.timezone,
        prompt: input.prompt,
        agentPreset: input.agentPreset,
        permissionPreset: input.permissionPreset,
        workspacePath: input.workspacePath,
        ...(input.title === undefined ? {} : { title: input.title }),
        enabled: true,
        deliver: input.deliverChannelId === undefined
          ? { kind: 'none' }
          : { kind: 'channel', channelId: input.deliverChannelId },
        ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
        createdAt: Date.now(),
      }
      await deps.jobsTable.put(record.name, record)
      return fromStored(record)
    },
    async update(name: string, patch: UpdateJobPatch): Promise<RegistryJob> {
      const current = requireStored(name, 'update')
      const deliver = patch.deliverChannelId === undefined
        ? current.deliver
        : patch.deliverChannelId === ''
          ? { kind: 'none' } as const
          : { kind: 'channel', channelId: patch.deliverChannelId } as const
      const next: StoredJobRecord = {
        ...current,
        ...(patch.expression === undefined ? {} : { expression: patch.expression }),
        ...(patch.timezone === undefined ? {} : { timezone: patch.timezone }),
        ...(patch.prompt === undefined ? {} : { prompt: patch.prompt }),
        ...(patch.agentPreset === undefined ? {} : { agentPreset: patch.agentPreset }),
        ...(patch.permissionPreset === undefined ? {} : { permissionPreset: patch.permissionPreset }),
        ...(patch.workspacePath === undefined ? {} : { workspacePath: patch.workspacePath }),
        ...(patch.title === undefined ? {} : { title: patch.title }),
        deliver,
      }
      assertAllowed(next, false)
      await deps.jobsTable.put(next.name, next)
      return fromStored(next)
    },
    async remove(name: string): Promise<void> {
      await changeState(async () => {
        requireStored(name, 'delete')
        const state = stateOf(name)
        if (state.activeRun !== undefined || state.pendingOutcome !== undefined) {
          registryError(`job "${name}" has a run or delivery pending; pause it and wait before deleting`)
        }
        await deps.jobsTable.delete(name)
        await deps.stateTable.delete(name)
      })
    },
    async setEnabled(name: string, enabled: boolean): Promise<RegistryJob> {
      if (registry.find(name) === undefined) registryError(`no job named "${name}"`)
      const record = deps.jobsTable.get(name)
      if (record !== undefined) {
        // A stored job keeps arm state in its own definition, so a re-pause never leaves an override
        // that would outlive a later edit of that field.
        await deps.jobsTable.put(record.name, { ...record, enabled })
      }
      await changeState(async () => {
        await deps.stateTable.put(name, { ...stateOf(name), enabled })
      })
      const job = registry.find(name)
      if (job === undefined) registryError(`job "${name}" disappeared while its arm state was being written`)
      return job
    },
    async setNotes(name: string, notes: string): Promise<void> {
      if (registry.find(name) === undefined) registryError(`no job named "${name}" to take notes`)
      if (notes.length > deps.guardrails.notesMaxChars) {
        registryError(`notes are ${String(notes.length)} characters, above the cap of `
          + `${String(deps.guardrails.notesMaxChars)}; shorten them`)
      }
      await changeState(async () => {
        await deps.stateTable.put(name, { ...stateOf(name), notes })
      })
    },
    async beginRun(name, run) {
      await changeState(async () => {
        if (registry.find(name)?.enabled !== true) registryError(`job "${name}" is not armed`)
        const state = stateOf(name)
        if (state.activeRun !== undefined || state.pendingOutcome !== undefined) {
          registryError(`job "${name}" has an unfinished run or delivery`)
        }
        await deps.stateTable.put(name, { ...state, activeRun: run })
      })
    },
    async settleRun(name, result, keepHistory) {
      return await changeState(async () => {
        const { activeRun, ...state } = stateOf(name)
        if (activeRun === undefined) registryError(`job "${name}" has no active run to settle`)
        const pendingOutcome = { ...activeRun, ...result, sessionId: activeRun.sessionId }
        const entry = { firedAt: activeRun.firedAt, sessionId: activeRun.sessionId, outcome: result.outcome }
        await deps.stateTable.put(name, {
          ...state,
          lastRuns: [entry, ...state.lastRuns].slice(0, keepHistory),
          pendingOutcome,
        })
        return finishedPayload(name, pendingOutcome)
      })
    },
    pendingOutcome(name) {
      const pending = stateOf(name).pendingOutcome
      return pending === undefined ? undefined : finishedPayload(name, pending)
    },
    async acknowledgeOutcome(name, sessionId) {
      await changeState(async () => {
        const { pendingOutcome, ...state } = stateOf(name)
        if (pendingOutcome?.sessionId === sessionId) await deps.stateTable.put(name, state)
      })
    },
    async recoverRuns(keepHistory) {
      for (const [name, state] of deps.stateTable.entries()) {
        if (state.activeRun !== undefined) {
          await registry.settleRun(name, { outcome: 'interrupted', sessionId: state.activeRun.sessionId, text: '' }, keepHistory)
        }
      }
      return [...deps.stateTable.keys()].flatMap((name) => {
        const pending = registry.pendingOutcome(name)
        return pending === undefined ? [] : [pending]
      })
    },
  }
  return registry
}
