/**
 * The Beardy patch keeps deployment data out of the repository: every Discord
 * row mounts only when a bot token exists, and an enabled row must receive its
 * destinations and authority from a profile layer — otherwise it fails loud at
 * load naming the missing required field instead of running on defaults.
 */

import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import Loader, { evaluate, type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import * as ToolDiscord from '@deepseek-ai/dsh-tool-discord'
import { Config as GatewayConfig } from '@deepseek-ai/dsh-discord-gateway'

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The patch rows the bundle declares, insert blocks flattened. */
function patchRows(): JsonRecord[] {
  const parsed: unknown = yaml.load(
    readFileSync(resolve(fileURLToPath(new URL('..', import.meta.url)), 'cordis.patch.yml'), 'utf8'),
    { schema: entryListSchema },
  )
  if (!Array.isArray(parsed)) throw new TypeError('Beardy patch must contain an entry list')
  return parsed.flatMap(entry =>
    isRecord(entry) && Array.isArray(entry.insert) ? entry.insert.filter(isRecord) : isRecord(entry) ? [entry] : [],
  )
}

const contexts: Context[] = []
let root: string | undefined

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot a cordis.yml carrying one tool-discord row through the real Loader.
 * @param configLines - YAML lines nested under the row's `config:`; empty omits the block.
 * @returns the booted context.
 */
async function bootWithDiscordRow(configLines: readonly string[]): Promise<Context> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-beardy-composition-'))
  root = home
  const configPath = join(home, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-discord'",
    ...(configLines.length > 0 ? ['  config:', ...configLines] : []),
    '',
  ].join('\n'))

  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(home).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-discord', ToolDiscord],
  ])
  ctx.loader.internal = {
    version: 'v2',
    loadCache: new Map(),
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } satisfies ModuleLoaderV2
  ctx.provide('credentials' as never, {
    resolve: async () => ({ value: 'token', source: 'env' }),
  } as never)
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  // The Loader is non-transactional: an entry whose apply threw stays inactive
  // and its failure is reported on its own fiber, so join them here to keep
  // this helper rejecting for a composition the bundle refuses.
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}

describe('dsh-beardy composition gating', () => {
  it('resolves Beardy deployment rows and user preset references through the Loader without opening a transport', async () => {
    const bundleRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
    const layers = ['base', 'web-app', 'beardy'].map((name) => {
      const dir = resolve(bundleRoot, name)
      const manifest = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as {
        dsh: { bundle: { patch: string | string[] } }
      }
      return [manifest.dsh.bundle.patch].flat().flatMap(file => loadOverlayPatches('beardy composition', resolve(dir, file)))
    })
    const personal = [
      { id: 'speech-whisper', disabled: false },
      { id: 'tool-discord', disabled: false, config: { tokenEnv: 'DISCORD_BOT_TOKEN', channelId: '123456789012345678' } },
      { id: 'discord-gateway', disabled: false, config: {
        tokenEnv: 'DISCORD_BOT_TOKEN', allowedUserIds: ['123456789012345678'], workspacePath: '/tmp/beardy-test',
        agentPreset: 'beardy-discord', permissionPreset: 'danger-full-access', enabled: false,
        userLanes: { '123456789012345679': {
          workspacePath: '/tmp/mamabear-test', agentPreset: 'beardy-mamabear', permissionPreset: 'workspace-write',
          toolFilter: { allow: ['web_search', 'web_fetch', 'schedule_create', 'fantasy_team_memory', 'session_search'] },
        } },
      } },
      { id: 'cron', disabled: false, config: {
        jobs: [], allowedAgentPresets: ['beardy-unattended', 'beardy-brief'],
        allowedPermissionPresets: ['workspace-write'], allowedWorkspaceRoots: ['/tmp/beardy-test'],
      } },
      { id: 'tool-odysseus-research', disabled: true },
      { insert: [{ id: 'training-export', name: '@deepseek-ai/dsh-experimental-training-export', config: { root: '/tmp/beardy-training-test' } }] },
      { insert: [
        { id: 'preset-beardy-brief', name: '@deepseek-ai/dsh-agent-preset', config: {
          id: 'beardy-brief', picker: 'hidden', plugins: [
            { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'Write the brief.' } },
            { id: 'brief-script', name: 'file:///tmp/beardy-brief-script/index.js' },
          ],
        } },
        { id: 'preset-beardy-mamabear', name: '@deepseek-ai/dsh-agent-preset', config: {
          id: 'beardy-mamabear', picker: 'hidden', plugins: [
            { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'Help Mamabear.' } },
            { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' },
            { id: 'tool-memory', name: '@deepseek-ai/dsh-tool-memory' },
          ],
        } },
      ] },
    ]
    const shipped = composeEntries(layers)
    expect(shipped.some(row => row.id === 'preset-beardy-brief' || row.id === 'preset-beardy-mamabear')).toBe(false)
    const warnings: string[] = []
    const rows = composeEntries([...layers, personal], warning => warnings.push(warning))
    expect(warnings).toEqual([])
    const byId = (id: string) => {
      const row = rows.find(candidate => candidate.id === id)
      if (row === undefined) throw new Error(`missing composed entry ${id}`)
      return row
    }
    for (const [id, name] of [
      ['speech-whisper', '@deepseek-ai/dsh-speech-whisper'],
      ['tool-discord', '@deepseek-ai/dsh-tool-discord'],
      ['discord-gateway', '@deepseek-ai/dsh-discord-gateway'],
      ['cron', '@deepseek-ai/dsh-cron'],
      ['tool-odysseus-research', '@deepseek-ai/dsh-tool-odysseus-research'],
      ['web-fetch-http', '@deepseek-ai/dsh-web-fetch-http'],
      ['training-export', '@deepseek-ai/dsh-experimental-training-export'],
      ['subagent-model-selection-settings', '@deepseek-ai/dsh-tool-subagent/model-selection-settings'],
    ] as const) expect(byId(id).name).toBe(name)
    expect(byId('speech-whisper').disabled).toBe(false)
    expect(byId('discord-gateway').config).toMatchObject({
      agentPreset: 'beardy-discord', permissionPreset: 'danger-full-access',
      userLanes: { '123456789012345679': { agentPreset: 'beardy-mamabear', permissionPreset: 'workspace-write' } },
    })
    expect(byId('cron').config).toMatchObject({ allowedAgentPresets: ['beardy-unattended', 'beardy-brief'] })
    expect(byId('schedule').disabled).toBe(false)
    const permission: unknown = byId('permission').config
    if (!isRecord(permission) || !isRecord(permission.presets)) throw new Error('missing permission presets')
    expect(Object.keys(permission.presets)).toContain('workspace-write')
    expect(Object.keys(permission.presets)).toContain('danger-full-access')

    const presets = rows.filter(row => row.name === '@deepseek-ai/dsh-agent-preset')
    const presetIds = presets.map(row => (row.config as { id: string }).id)
    for (const id of ['beardy', 'beardy-discord', 'beardy-unattended', 'beardy-brief', 'beardy-mamabear']) {
      expect(presetIds.filter(candidate => candidate === id)).toHaveLength(1)
    }
    for (const id of ['beardy', 'beardy-discord', 'beardy-unattended']) {
      const preset = presets.find(row => (row.config as { id: string }).id === id)
      const children = (preset!.config as { plugins: JsonRecord[] }).plugins
      const delegation = children.find(row => row.id === 'delegation')
      if (delegation === undefined || !Array.isArray(delegation.config)) throw new Error(`missing ${id} delegation`)
      for (const childId of ['tool-subagent', 'tool-subagent-fork', 'tool-subagent-codex', 'tool-subagent-claude-code']) {
        expect(delegation.config.some(row => isRecord(row) && row.id === childId), `${id}/${childId}`).toBe(true)
      }
    }
    const brief = presets.find(row => (row.config as { id: string }).id === 'beardy-brief')
    expect(brief?.config).toMatchObject({ picker: 'hidden', plugins: [
      { id: 'persona', config: { prefix: 'Write the brief.' } },
      { id: 'brief-script' },
    ] })
    const mamabear = presets.find(row => (row.config as { id: string }).id === 'beardy-mamabear')
    if (mamabear === undefined || !isRecord(mamabear.config) || !Array.isArray(mamabear.config.plugins)) {
      throw new Error('missing Mamabear preset plugins')
    }
    const mamabearIds = mamabear.config.plugins.filter(isRecord).map(row => row.id)
    expect(mamabearIds).toEqual(['persona', 'tool-web', 'tool-memory'])
    for (const forbidden of ['tool-bash', 'tool-pwsh', 'tool-fs', 'tool-discord']) expect(mamabearIds).not.toContain(forbidden)

    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = pathToFileURL(bundleRoot).href + '/'
    await ctx.plugin(Loader)
    const mounted: string[] = []
    const transportStub = { apply(context: Context) { mounted.push(context.fiber.entry?.options.id ?? '') } }
    const moduleLoader = ctx.loader.internal
    if (moduleLoader === undefined) throw new Error('Loader import seam unavailable')
    ctx.loader.internal = new Proxy(moduleLoader, {
      get(target, key, receiver) {
        if (key === 'import') return async () => ({ default: transportStub })
        const value: unknown = Reflect.get(target, key, receiver)
        return value
      },
    })
    ctx.provide('credentials' as never, { resolve: async () => ({ value: 'dummy-token', source: 'env' }) } as never)
    for (const id of [
      'speech-whisper', 'tool-discord', 'discord-gateway', 'cron', 'tool-odysseus-research', 'web-fetch-http',
      'training-export', 'preset-beardy-brief', 'preset-beardy-mamabear',
    ]) {
      const row = byId(id)
      await ctx.loader.create({ ...row, disabled: false })
    }
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    expect(mounted).toEqual(expect.arrayContaining([
      'speech-whisper', 'tool-discord', 'discord-gateway', 'cron', 'tool-odysseus-research', 'web-fetch-http', 'training-export',
      'preset-beardy-brief', 'preset-beardy-mamabear',
    ]))
  })

  it('mounts every Discord row only when a bot token is present', () => {
    const rows = patchRows()
    for (const id of ['tool-discord', 'discord-gateway', 'cron']) {
      const row = rows.find(candidate => candidate.id === id)
      if (row === undefined) throw new Error(`beardy patch must mount ${id}`)
      const expression = (row.disabled as { __jsExpr?: string } | undefined)?.__jsExpr
      if (expression === undefined) throw new Error(`${id} must gate on a !!js disabled expression`)
      expect(Boolean(evaluate({ process: { env: {} } }, expression)), `${id} without token`).toBe(true)
      expect(
        Boolean(evaluate({ process: { env: { DISCORD_BOT_TOKEN: 'x' } } }, expression)),
        `${id} with token`,
      ).toBe(false)
    }
  })

  it('carries no destination, allowlist, timezone, or workspace values', () => {
    const source = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')
    const code = source.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')
    for (const personal of ['channelId', 'dmUserIds', 'allowedUserIds', 'workspacePath', 'Zagreb', 'process.cwd']) {
      expect(code.includes(personal), `bundle patch must not carry ${personal}`).toBe(false)
    }
    const rows = patchRows()
    expect(rows.find(row => row.id === 'tool-discord')?.config).toEqual({ tokenEnv: 'DISCORD_BOT_TOKEN' })
    expect(rows.find(row => row.id === 'discord-gateway')).not.toHaveProperty('config')
    expect(rows.find(row => row.id === 'cron')?.config).toEqual({ jobs: [] })
    expect(rows.find(row => row.id === 'health')?.config).toEqual({ probes: [] })
  })

  it('mounts the clock with an hourly injection throttle', () => {
    const row = patchRows().find(candidate => candidate.id === 'time-context')
    expect(row).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-time-context',
      config: { refreshIntervalMs: 3600000 },
    }))
  })

  it('fails loud naming channelId when no profile supplied a destination', async () => {
    await expect(bootWithDiscordRow(['    tokenEnv: DISCORD_BOT_TOKEN'])).rejects.toThrow(/channelId/)
  }, 60_000)

  it('mounts discord_send once a profile layer supplies the destination', async () => {
    const ctx = await bootWithDiscordRow([
      '    tokenEnv: DISCORD_BOT_TOKEN',
      "    channelId: '123456789012345678'",
    ])
    expect(ctx.tools.schemas().map(tool => tool.name)).toContain('discord_send')
  }, 60_000)

  it('fails loud naming allowedUserIds when the gateway row is enabled without profile authority data', () => {
    const result: unknown = GatewayConfig['~standard'].validate({
      tokenEnv: 'DISCORD_BOT_TOKEN',
      agentPreset: 'beardy-discord',
      permissionPreset: 'danger-full-access',
      workspacePath: '/home/example/beardy',
    })
    if (!isRecord(result) || !Array.isArray(result.issues)) throw new Error('Expected config issues')
    expect(result.issues.some((issue: unknown) => isRecord(issue)
      && typeof issue.message === 'string' && issue.message.includes('allowedUserIds'))).toBe(true)
  })
})
