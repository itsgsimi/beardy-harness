/**
 * The `/cron` slash command: the human-facing view and control of the job registry, answered
 * without a model turn. It works wherever slash commands run — the Web UI input bar and any chat
 * surface that dispatches commands.
 * @module @deepseek-ai/dsh-cron/command
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { Cron } from 'croner'
import type { JobRegistry, JobListing } from './registry.ts'

/** Seams into the live scheduler that the command cannot reach through the registry alone. */
export interface CronCommandDeps {
  /** Start a job immediately; false when it is not armed or unknown. */
  runNow(name: string): boolean
}

const USAGE = 'usage: /cron list | run <name> | pause <name> | resume <name> | delete <name>'

function nextFireLine(job: JobListing): string {
  if (!job.enabled) return `${job.name}: paused (${job.expression} ${job.timezone}, ${job.origin})`
  const next = new Cron(job.expression, { timezone: job.timezone, paused: true }).nextRun(new Date())
  return `${job.name}: ${job.expression} ${job.timezone} (${job.origin})`
    + (next === null ? '' : `, next ${new Date(next).toISOString()}`)
}

/** Run one subcommand against the registry, translating guardrail rejections into error results. */
export async function runCronSubcommand(
  rawInput: string,
  registry: JobRegistry,
  deps: CronCommandDeps,
): Promise<CommandResult> {
  const parts = rawInput.trim().split(/\s+/).filter(part => part !== '')
  const verb = parts[0] ?? 'list'
  const name = parts.slice(1).join(' ')
  try {
    switch (verb) {
      case 'list': {
        const jobs = registry.list()
        return { kind: 'success', text: jobs.length === 0 ? 'No cron jobs.' : jobs.map(nextFireLine).join('\n') }
      }
      case 'run': {
        if (name === '') return { kind: 'error', text: `which job? ${USAGE}` }
        if (registry.find(name) === undefined) return { kind: 'error', text: `no job named "${name}"` }
        if (!deps.runNow(name)) return { kind: 'error', text: `job "${name}" is paused; resume it first` }
        return { kind: 'success', text: `Started "${name}" outside its schedule.` }
      }
      case 'pause': {
        if (name === '') return { kind: 'error', text: `which job? ${USAGE}` }
        await registry.setEnabled(name, false)
        return { kind: 'success', text: `Paused "${name}"; its definition and notes stay.` }
      }
      case 'resume': {
        if (name === '') return { kind: 'error', text: `which job? ${USAGE}` }
        await registry.setEnabled(name, true)
        return { kind: 'success', text: `Resumed "${name}".` }
      }
      case 'delete': {
        if (name === '') return { kind: 'error', text: `which job? ${USAGE}` }
        await registry.remove(name)
        return { kind: 'success', text: `Deleted "${name}".` }
      }
      default:
        return { kind: 'error', text: USAGE }
    }
  } catch (error: unknown) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Register `/cron` on the command registry.
 * @param ctx - registrant context carrying the command registry.
 * @param registry - merged job view and its mutations.
 * @param deps - run-now seam into the live scheduler.
 */
export function registerCronCommand(ctx: Context, registry: JobRegistry, deps: CronCommandDeps): void {
  ctx.commands.register({
    name: 'cron',
    description: 'List, run, pause, resume, or delete cron jobs.',
    input: { hint: 'list | run <name> | pause <name> | resume <name> | delete <name>' },
    handler: invocation => runCronSubcommand(invocation.rawInput, registry, deps),
  })
}
