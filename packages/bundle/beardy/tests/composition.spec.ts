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
import Loader, { evaluate } from '@deepseek-ai/cordis-plugin-loader'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
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
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  ctx.provide('credentials' as never, {
    resolve: async () => ({ value: 'token', source: 'env' }),
  } as never)
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('dsh-beardy composition gating', () => {
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
    const parse = (): unknown => (GatewayConfig as unknown as (value: unknown) => unknown)({
      tokenEnv: 'DISCORD_BOT_TOKEN',
      agentPreset: 'beardy-discord',
      permissionPreset: 'danger-full-access',
      workspacePath: '/home/example/beardy',
    })
    expect(parse).toThrow(/allowedUserIds/)
  })
})
