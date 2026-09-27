/**
 * The model-facing job management tool: list, create, update, delete, pause, resume, run now, and
 * continuity notes. Guardrails from plugin configuration bound what a model may schedule, and
 * mutating actions can require the approval service before they land.
 * @module @deepseek-ai/dsh-cron/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { JobRegistry, RegistryJob } from './registry.ts'

/** Actions the tool exposes. */
export type CronManageAction = 'list' | 'create' | 'update' | 'delete' | 'pause' | 'resume' | 'run_now' | 'note'

interface CronManageArgs {
  action: CronManageAction
  name?: string
  expression?: string
  timezone?: string
  prompt?: string
  agent_preset?: string
  permission_preset?: string
  workspace_path?: string
  title?: string
  turn_timeout_ms?: number
  deliver_channel?: string
  notes?: string
}

interface CronManageResult {
  action: CronManageAction
  name?: string
  message: string
  jobs?: string[]
}

/** Tool dependencies beyond the registry. */
export interface CronManageToolDeps {
  /** Whether create, update, and delete ask the approval service first. */
  readonly requireApproval: boolean
  /** Start a job immediately; false when the name is not armed or unknown. */
  runNow(name: string): boolean
}

const CREATE_FIELDS = ['name', 'expression', 'timezone', 'prompt', 'agent_preset', 'permission_preset', 'workspace_path'] as const
const PATCH_FIELDS = ['expression', 'timezone', 'prompt', 'agent_preset', 'permission_preset', 'workspace_path', 'title', 'turn_timeout_ms', 'deliver_channel'] as const

function requireFields(args: CronManageArgs, action: CronManageAction): void {
  const required: readonly (keyof CronManageArgs)[] = action === 'create' ? CREATE_FIELDS : action === 'note' ? ['name', 'notes'] : ['name']
  const missing = required.filter((field) => {
    const value = args[field]
    return value === undefined || (field !== 'notes' && typeof value === 'string' && value.trim() === '')
  })
  if (missing.length > 0) throw new Error(`cron_manage ${action} requires: ${missing.join(', ')}`)
  if (action === 'update' && !PATCH_FIELDS.some(field => args[field] !== undefined)) {
    throw new Error(`cron_manage update requires at least one of: ${PATCH_FIELDS.join(', ')}`)
  }
}

function requireName(args: CronManageArgs, action: CronManageAction): string {
  requireFields(args, action)
  return (args.name as string).trim()
}

function requireAgent(exec: ToolExecution): Agent {
  if (exec.agent === undefined) throw new Error('cron_manage requires an Agent-backed session')
  return exec.agent
}

/** Ask the approval service about one mutating action; refuse when it is not granted. */
async function approvedForWrite(
  ctx: Context,
  exec: ToolExecution,
  action: CronManageAction,
  name: string,
  detail: string,
): Promise<void> {
  const agent = requireAgent(exec)
  const approval = ctx.get('approval')
  if (approval === undefined) {
    throw new Error(`cron job ${action} "${name}" needs approval (${detail}), but no approval service is mounted`)
  }
  const outcome = await approval.request({
    agent,
    toolName: 'cron_manage',
    callId: exec.callId,
    reason: `Cron ${action}: ${detail}`,
    signal: exec.signal,
  })
  if (outcome !== 'allowed-once') {
    throw new Error(`cron job ${action} "${name}" was not approved (${outcome}); nothing changed`)
  }
}

function describeCreate(args: CronManageArgs, name: string): string {
  return `"${name}" (${args.expression} ${args.timezone}) preset ${args.agent_preset}`
    + `/${args.permission_preset} in ${args.workspace_path}`
}

function line(job: RegistryJob): string {
  const state = job.enabled ? job.origin : `${job.origin}, paused`
  return `${job.name}: ${job.expression} ${job.timezone} (${state})`
}

/**
 * Build the `cron_manage` tool definition over one registry.
 * @param ctx - context carrying the approval service read at call time.
 * @param registry - merged job view and its guardrailed mutations.
 * @param deps - approval stance and the run-now seam into the live scheduler.
 * @returns the tool definition to register on `ctx.tools`.
 */
export function createCronManageTool(
  ctx: Context,
  registry: JobRegistry,
  deps: CronManageToolDeps,
): ToolDefinition {
  return defineTool({
    name: 'cron_manage',
    description:
      'Manage the global cron jobs that wake an agent on a schedule. Actions: "list" shows every job '
      + 'with its origin and arm state; "create" schedules a new stored job (name, expression, timezone, '
      + 'prompt, agent_preset, permission_preset, workspace_path required; title, turn_timeout_ms and deliver_channel '
      + 'optional); "update" requires name and at least one patch field; "delete" requires name; "pause" and "resume" '
      + 'require name to stop or re-arm any job of either origin without losing it, and the pause survives a restart; "run_now" '
      + 'requires name to start a job immediately outside its schedule; "note" requires name and notes, and replaces the continuity notes carried into '
      + 'every future run of the job — record what was reported so the next run continues instead of '
      + 'repeating. A job from plugin configuration keeps its definition read-only: change its schedule '
      + 'or prompt by editing that configuration, which takes effect when the host restarts.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'create', 'update', 'delete', 'pause', 'resume', 'run_now', 'note'], description: 'Operation to perform.' },
      name: { type: 'string', description: 'Required for create, update, delete, pause, resume, run_now, and note; omit only for list.' },
      expression: { type: 'string', description: 'Required for create; optional patch for update. Cron expression with 5 or 6 fields.' },
      timezone: { type: 'string', description: 'Required for create; optional patch for update. IANA timezone.' },
      prompt: { type: 'string', description: 'Required for create; optional patch for update. Prompt for every fire.' },
      agent_preset: { type: 'string', description: 'Required for create; optional patch for update.' },
      permission_preset: { type: 'string', description: 'Required for create; optional patch for update.' },
      workspace_path: { type: 'string', description: 'Required for create; optional patch for update. Absolute path.' },
      title: { type: 'string', description: 'Optional for create and update. Session title override.' },
      turn_timeout_ms: { type: 'number', description: 'Optional for create and update. Per-run timeout in milliseconds, at least 1000; omit to use plugin turnTimeoutMs.' },
      deliver_channel: { type: 'string', description: 'Optional for create and update. Channel id for final text; an empty string removes delivery.' },
      notes: { type: 'string', description: 'Required for note. Full replacement continuity notes; use an empty string to clear.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, enum: ['list', 'create', 'update', 'delete', 'pause', 'resume', 'run_now', 'note'] },
          name: { type: 'string' },
          message: { type: 'string', required: true },
          jobs: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.jobs === undefined ? value.message : `${value.message}\n${value.jobs.join('\n')}`,
      }],
    },
    async execute(args: CronManageArgs, exec): Promise<CronManageResult> {
      switch (args.action) {
        case 'list': {
          const jobs = registry.list()
          return {
            action: 'list',
            message: `${String(jobs.length)} job(s).`,
            jobs: jobs.map(job => `${line(job)}${job.notes === '' ? '' : ' [has notes]'}`),
          }
        }
        case 'create': {
          const name = requireName(args, 'create')
          if (deps.requireApproval) await approvedForWrite(ctx, exec, 'create', name, describeCreate(args, name))
          const created = await registry.create({
            name,
            expression: args.expression as string,
            timezone: args.timezone as string,
            prompt: args.prompt as string,
            agentPreset: args.agent_preset as string,
            permissionPreset: args.permission_preset as string,
            workspacePath: args.workspace_path as string,
            ...(args.title === undefined ? {} : { title: args.title }),
            ...(args.turn_timeout_ms === undefined ? {} : { turnTimeoutMs: args.turn_timeout_ms }),
            ...(args.deliver_channel === undefined ? {} : { deliverChannelId: args.deliver_channel }),
            ...(exec.agent === undefined ? {} : { createdBy: String(exec.agent.session.header.id) }),
          })
          return { action: 'create', name, message: `Created job ${line(created)}.` }
        }
        case 'update': {
          const name = requireName(args, 'update')
          if (deps.requireApproval) await approvedForWrite(ctx, exec, 'update', name, `patch "${name}"`)
          const updated = await registry.update(name, {
            ...(args.expression === undefined ? {} : { expression: args.expression }),
            ...(args.timezone === undefined ? {} : { timezone: args.timezone }),
            ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
            ...(args.agent_preset === undefined ? {} : { agentPreset: args.agent_preset }),
            ...(args.permission_preset === undefined ? {} : { permissionPreset: args.permission_preset }),
            ...(args.workspace_path === undefined ? {} : { workspacePath: args.workspace_path }),
            ...(args.title === undefined ? {} : { title: args.title }),
            ...(args.turn_timeout_ms === undefined ? {} : { turnTimeoutMs: args.turn_timeout_ms }),
            ...(args.deliver_channel === undefined ? {} : { deliverChannelId: args.deliver_channel }),
          })
          return { action: 'update', name, message: `Updated job ${line(updated)}.` }
        }
        case 'delete': {
          const name = requireName(args, 'delete')
          if (deps.requireApproval) await approvedForWrite(ctx, exec, 'delete', name, `remove "${name}"`)
          await registry.remove(name)
          return { action: 'delete', name, message: `Deleted job "${name}".` }
        }
        case 'pause': {
          const name = requireName(args, 'pause')
          const paused = await registry.setEnabled(name, false)
          return { action: 'pause', name, message: `Paused job ${line(paused)}.` }
        }
        case 'resume': {
          const name = requireName(args, 'resume')
          const resumed = await registry.setEnabled(name, true)
          return { action: 'resume', name, message: `Resumed job ${line(resumed)}.` }
        }
        case 'run_now': {
          const name = requireName(args, 'run_now')
          if (registry.find(name) === undefined) throw new Error(`no job named "${name}"`)
          if (!deps.runNow(name)) throw new Error(`job "${name}" is paused; resume it first`)
          return { action: 'run_now', name, message: `Started job "${name}" outside its schedule.` }
        }
        case 'note': {
          const name = requireName(args, 'note')
          await registry.setNotes(name, args.notes as string)
          return { action: 'note', name, message: `Notes for job "${name}" replaced.` }
        }
      }
    },
  })
}
