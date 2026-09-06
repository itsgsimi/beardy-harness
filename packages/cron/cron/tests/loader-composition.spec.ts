import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, describe, expect, it } from 'vitest'
import * as Cron from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** What the fixture services record while the composition runs. */
interface FixtureRecord {
  created: string[]
  tools: string[]
  commands: string[]
  storedJobs: Map<string, Record<string, unknown>>
}

/** Services a scheduled run mounts through; the session factory records whether it was used. */
function fixtureDependencies(record: FixtureRecord): unknown {
  const events: Record<string, unknown>[] = []
  return {
    name: 'fixture-dependencies',
    apply(ctx: Context) {
      ctx.provide('agents' as never, {
        create: async (options: { sessionId: string }) => {
          record.created.push(options.sessionId)
          return {
            agent: {
              session: { get seq(): number { return events.length }, ownEvents: () => events },
              followup: () => {
                events.push({
                  seq: events.length + 1,
                  type: 'assistant/message',
                  data: { message: { content: [{ type: 'text', text: 'Brief ready.' }] } },
                })
              },
              whenIdle: async () => {},
            },
            dispose: async () => {},
          }
        },
      } as never)
      ctx.provide('agentDefaultModel' as never, {
        currentSelection: () => ({ provider: 'fixture-provider', model: 'fixture-model' }),
      } as never)
      ctx.provide('agentPresets' as never, {
        resolve: async (name: string) => ({ id: name }),
        mount: async () => {},
      } as never)
      ctx.provide('permissionPresets' as never, { resolve: () => ({}), set: () => {} } as never)
      ctx.provide('sessionTitle' as never, { rename: () => {} } as never)
      ctx.provide('workspaceRegistry' as never, {
        create: async (path: string) => ({
          path, attachSession: async () => {}, detachSession: async () => {},
        }),
      } as never)
      ctx.provide('tools' as never, {
        register: (tool: { name: string }) => { record.tools.push(tool.name); return () => {} },
      } as never)
      ctx.provide('commands' as never, {
        register: (command: { name: string }) => { record.commands.push(command.name); return () => {} },
      } as never)
      const state = new Map<string, Record<string, unknown>>()
      const tableFor = (name: string): Map<string, Record<string, unknown>> =>
        name === 'jobs' ? record.storedJobs : state
      ctx.provide('storageDomain' as never, {
        open: async () => ({
          name: 'cron_jobs',
          table: (name: string) => {
            const rows = tableFor(name)
            return {
              get: (key: string) => rows.get(key),
              entries: () => rows.entries(),
              keys: () => rows.keys(),
              size: rows.size,
              put: async (key: string, value: Record<string, unknown>) => { rows.set(key, value) },
              delete: async (key: string) => rows.delete(key),
            }
          },
          close: async () => {},
        }),
      } as never)
    },
  }
}

/** Boot a composition that mounts the real scheduler over the stub services. */
async function boot(
  lines: readonly string[],
  storedJobs: Record<string, unknown>[] = [],
): Promise<{ ctx: Context; record: FixtureRecord }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-cron-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, ['- name: fixture-dependencies', ...lines, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const record: FixtureRecord = { created: [], tools: [], commands: [], storedJobs: new Map() }
  for (const job of storedJobs) record.storedJobs.set(String(job.name), job)
  const modules = new Map<string, unknown>([
    ['fixture-dependencies', fixtureDependencies(record)],
    ['@deepseek-ai/dsh-cron', Cron],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return { ctx: context, record }
}

/** One job row; only the schedule and identity vary between cases. */
function jobRows(name: string, expression: string): string[] {
  return [
    "- name: '@deepseek-ai/dsh-cron'",
    '  config:',
    '    jobs:',
    `      - name: ${name}`,
    `        expression: '${expression}'`,
    "        timezone: 'Europe/Zagreb'",
    "        prompt: 'Summarize the feeds and the weather.'",
    '        agentPreset: beardy',
    '        permissionPreset: danger-full-access',
    `        workspacePath: ${process.cwd()}`,
  ]
}

/** Loader entries that were requested but never mounted. */
function unloaded(ctx: Context): string[] {
  return [...ctx.loader.entries()]
    .filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)
}

describe('dsh-cron real Loader composition', () => {
  it('mounts with an empty job list and starts nothing', { timeout: 60_000 }, async () => {
    const { ctx, record } = await boot(["- name: '@deepseek-ai/dsh-cron'", '  config:', '    jobs: []'])
    expect(unloaded(ctx)).toEqual([])
    expect(record.tools).toEqual(['cron_manage'])
    expect(record.commands).toEqual(['cron'])
  })

  it('schedules a configured job without starting a session before its time', { timeout: 60_000 }, async () => {
    const { ctx } = await boot(jobRows('morning-brief', '0 7 * * *'))
    expect(unloaded(ctx)).toEqual([])
    await new Promise(resolve => setTimeout(resolve, 20))
  })

  it('refuses two jobs sharing one name', { timeout: 60_000 }, async () => {
    await expect(boot([
      "- name: '@deepseek-ai/dsh-cron'",
      '  config:',
      '    jobs:',
      '      - name: brief',
      "        expression: '0 7 * * *'",
      "        timezone: 'Europe/Zagreb'",
      "        prompt: 'one'",
      '        agentPreset: beardy',
      '        permissionPreset: danger-full-access',
      `        workspacePath: ${process.cwd()}`,
      '      - name: brief',
      "        expression: '0 8 * * *'",
      "        timezone: 'Europe/Zagreb'",
      "        prompt: 'two'",
      '        agentPreset: beardy',
      '        permissionPreset: danger-full-access',
      `        workspacePath: ${process.cwd()}`,
    ])).rejects.toThrow('job names must be unique')
  })

  it('refuses a schedule it cannot parse', { timeout: 60_000 }, async () => {
    await expect(boot(jobRows('broken', 'every morning'))).rejects.toThrow('unusable schedule')
  })

  it('refuses a stored job colliding with a configured name', { timeout: 60_000 }, async () => {
    await expect(boot(jobRows('morning-brief', '0 7 * * *'), [{
      name: 'morning-brief', expression: '0 9 * * 1', timezone: 'Europe/Zagreb', prompt: 'Check PRs.',
      agentPreset: 'beardy', permissionPreset: 'workspace-write', workspacePath: '/srv/x',
      enabled: true, deliver: { kind: 'none' }, createdAt: 1,
    }])).rejects.toThrow('collides')
  })

  it('schedules a stored job that survived the restart', { timeout: 60_000 }, async () => {
    const { ctx } = await boot(["- name: '@deepseek-ai/dsh-cron'", '  config:', '    jobs: []'], [{
      name: 'pr-check', expression: '0 9 * * 1', timezone: 'Europe/Zagreb', prompt: 'Check PRs.',
      agentPreset: 'beardy', permissionPreset: 'workspace-write', workspacePath: '/srv/x',
      enabled: true, deliver: { kind: 'none' }, createdAt: 1,
    }])
    expect(unloaded(ctx)).toEqual([])
  })
})
