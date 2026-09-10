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

function requireName(args: CronManageArgs): string {
  if (args.name === undefined || args.name.trim() === '') {
    throw new Error('cron_manage needs "name" for this action')
  }
  return args.name.trim()
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
  return `"${name}" (${args.expression ?? '?'} ${args.timezone ?? '?'}) preset ${args.agent_preset ?? '?'}`
    + `/${args.permission_preset ?? '?'} in ${args.workspace_path ?? '?'}`
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
      + 'prompt, agent_preset, permission_preset, workspace_path required; title and deliver_channel '
      + 'optional); "update" patches a stored job; "delete" removes one; "pause" and "resume" stop or '
      + 're-arm any job of either origin without losing it, and the pause survives a restart; "run_now" '
      + 'starts a job immediately outside its schedule; "note" replaces the continuity notes carried into '
      + 'every future run of the job — record what was reported so the next run continues instead of '
      + 'repeating. A job from plugin configuration keeps its definition read-only: change its schedule '
      + 'or prompt by editing that configuration, which takes effect when the host restarts.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'create', 'update', 'delete', 'pause', 'resume', 'run_now', 'note'], description: 'Operation to perform.' },
      name: { type: 'string', description: 'Job name. Required for every action except list and create; the new job\'s name for create.' },
      expression: { type: 'string', description: 'Cron expression, 5 or 6 fields, for create and update.' },
      timezone: { type: 'string', description: 'IANA timezone the expression runs in, for create and update.' },
      prompt: { type: 'string', description: 'Prompt handed to the agent on every fire, for create and update.' },
      agent_preset: { type: 'string', description: 'Agent preset for the run, for create and update.' },
      permission_preset: { type: 'string', description: 'Permission preset for the run, for create and update.' },
      workspace_path: { type: 'string', description: 'Absolute workspace path for the run, for create and update.' },
      title: { type: 'string', description: 'Optional Session title override.' },
      deliver_channel: { type: 'string', description: 'Channel id to deliver the finished run\'s text to; an empty string removes delivery.' },
      notes: { type: 'string', description: 'Full replacement notes text for the "note" action.' },
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
          const name = requireName(args)
          if (deps.requireApproval) await approvedForWrite(ctx, exec, 'create', name, describeCreate(args, name))
          const created = await registry.create({
            name,
            expression: args.expression ?? '',
            timezone: args.timezone ?? '',
            prompt: args.prompt ?? '',
            agentPreset: args.agent_preset ?? '',
            permissionPreset: args.permission_preset ?? '',
            workspacePath: args.workspace_path ?? '',
            ...(args.title === undefined ? {} : { title: args.title }),
            ...(args.deliver_channel === undefined ? {} : { deliverChannelId: args.deliver_channel }),
            ...(exec.agent === undefined ? {} : { createdBy: String(exec.agent.session.header.id) }),
          })
          return { action: 'create', name, message: `Created job ${line(created)}.` }
        }
        case 'update': {
          const name = requireName(args)
          if (deps.requireApproval) await approvedForWrite(ctx, exec, 'update', name, `patch "${name}"`)
          const updated = await registry.update(name, {
            ...(args.expression === undefined ? {} : { expression: args.expression }),
            ...(args.timezone === undefined ? {} : { timezone: args.timezone }),
            ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
            ...(args.agent_preset === undefined ? {} : { agentPreset: args.agent_preset }),
            ...(args.permission_preset === undefined ? {} : { permissionPreset: args.permission_preset }),
            ...(args.workspace_path === undefined ? {} : { workspacePath: args.workspace_path }),
            ...(args.title === undefined ? {} : { title: args.title }),
            ...(args.deliver_channel === undefined ? {} : { deliverChannelId: args.deliver_channel }),
          })
          return { action: 'update', name, message: `Updated job ${line(updated)}.` }
        }
        case 'delete': {
          const name = requireName(args)
          if (deps.requireApproval) await approvedForWrite(ctx, exec, 'delete', name, `remove "${name}"`)
          await registry.remove(name)
          return { action: 'delete', name, message: `Deleted job "${name}".` }
        }
        case 'pause': {
          const name = requireName(args)
          const paused = await registry.setEnabled(name, false)
          return { action: 'pause', name, message: `Paused job ${line(paused)}.` }
        }
        case 'resume': {
          const name = requireName(args)
          const resumed = await registry.setEnabled(name, true)
          return { action: 'resume', name, message: `Resumed job ${line(resumed)}.` }
        }
        case 'run_now': {
          const name = requireName(args)
          if (registry.find(name) === undefined) throw new Error(`no job named "${name}"`)
          if (!deps.runNow(name)) throw new Error(`job "${name}" is paused; resume it first`)
          return { action: 'run_now', name, message: `Started job "${name}" outside its schedule.` }
        }
        case 'note': {
          const name = requireName(args)
          await registry.setNotes(name, args.notes ?? '')
          return { action: 'note', name, message: `Notes for job "${name}" replaced.` }
        }
      }
    },
  })
}
