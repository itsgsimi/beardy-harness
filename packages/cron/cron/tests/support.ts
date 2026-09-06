/**
 * Shared fixtures for the cron package specs: in-memory tables, guardrail presets, and a registry
 * wired over them.
 * @module tests/support
 */

import type { CreateJobInput, JobGuardrails } from '../src/registry.ts'
import { createJobRegistry } from '../src/registry.ts'
import type { CronJobSpec } from '../src/types.ts'
import type { JobStateRecord, StoredJobRecord } from '../src/domain.ts'

/** In-memory KvTable stand-in over a plain map. */
export function fakeTable<T>(backing = new Map<string, T>()) {
  return {
    rows: backing,
    get: (key: string) => backing.get(key),
    entries: () => backing.entries(),
    keys: () => backing.keys(),
    size: backing.size,
    put: async (key: string, value: T) => { backing.set(key, value) },
    delete: async (key: string) => backing.delete(key),
    update: async (key: string, fn: (current: T) => T) => {
      const next = fn(backing.get(key) as T)
      backing.set(key, next)
      return next
    },
  }
}

/** Guardrail preset for the specs: one preset pair and one workspace root, generous bounds. */
export const GUARDRAILS: JobGuardrails = {
  allowedAgentPresets: ['beardy'],
  allowedPermissionPresets: ['workspace-write'],
  allowedWorkspaceRoots: ['/srv'],
  maxStoredJobs: 5,
  minIntervalMs: 60_000,
  notesMaxChars: 400,
}

/** A configured job the specs reuse. */
export const CONFIG_JOB: CronJobSpec = {
  name: 'morning-brief',
  expression: '0 7 * * *',
  timezone: 'Europe/Zagreb',
  prompt: 'Summarize the feeds.',
  agentPreset: 'beardy',
  permissionPreset: 'danger-full-access',
  workspacePath: '/workspace',
}

/** A complete create input that passes the spec guardrails. */
export function createInput(overrides: Partial<CreateJobInput> = {}): CreateJobInput {
  return {
    name: 'pr-check',
    expression: '0 9 * * 1',
    timezone: 'Europe/Zagreb',
    prompt: 'Check open pull requests.',
    agentPreset: 'beardy',
    permissionPreset: 'workspace-write',
    workspacePath: '/srv/repo',
    ...overrides,
  }
}

/** A stored job row as the durable table holds it. */
export function storedRow(name: string, overrides: Partial<StoredJobRecord> = {}): StoredJobRecord {
  return {
    name,
    expression: '0 9 * * 1',
    timezone: 'Europe/Zagreb',
    prompt: 'Check open pull requests.',
    agentPreset: 'beardy',
    permissionPreset: 'workspace-write',
    workspacePath: '/srv/repo',
    enabled: true,
    deliver: { kind: 'none' },
    createdAt: 1,
    ...overrides,
  }
}

/** Registry over fresh in-memory tables with the spec guardrails. */
export function makeRegistry(
  configJobs: readonly CronJobSpec[] = [],
  options: {
    readonly stored?: StoredJobRecord[]
    readonly state?: Record<string, JobStateRecord>
    readonly delivery?: ReadonlyMap<string, string>
    readonly guardrails?: Partial<JobGuardrails>
  } = {},
) {
  const jobsTable = fakeTable<StoredJobRecord>()
  const stateTable = fakeTable<JobStateRecord>()
  for (const record of options.stored ?? []) jobsTable.rows.set(record.name, record)
  for (const [name, state] of Object.entries(options.state ?? {})) stateTable.rows.set(name, state)
  const registry = createJobRegistry({
    configJobs,
    configDelivery: options.delivery ?? new Map(),
    jobsTable,
    stateTable,
    guardrails: { ...GUARDRAILS, ...options.guardrails },
  })
  return { registry, jobsTable, stateTable }
}
