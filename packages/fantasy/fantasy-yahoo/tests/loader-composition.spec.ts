import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import YahooFantasyService from '../src/index.ts'
import * as ToolFantasy from '../../tool-fantasy/src/index.ts'

let root: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  try { await ctx?.fiber.dispose() }
  finally {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    root = undefined
    ctx = undefined
  }
})

it('mounts and disposes the Definition, Provider, and Consumer through Loader', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-fantasy-loader-'))
  const home = join(root, 'home')
  await mkdir(home, { mode: 0o700 })
  vi.stubEnv('DSH_HOME', home)
  const tokenFile = join(home, 'fantasy.json')
  await writeFile(tokenFile, JSON.stringify({
    consumer_key: 'fixture-client', consumer_secret: 'fixture-secret',
    access_token: 'fixture-access', refresh_token: 'fixture-refresh',
    token_type: 'bearer', token_time: Date.now() / 1000,
  }), { mode: 0o600 })
  ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-fantasy-yahoo'",
    '  config:',
    `    tokenFile: ${tokenFile}`,
    '    redirectUri: https://localhost:8080/oauth',
    '    season: 2026',
    '    callerTeams:',
    '      beardy: 470.l.809970.t.7',
    '    authPresets: [beardy]',
    "- name: '@deepseek-ai/dsh-tool-fantasy'",
    '',
  ].join('\n'))
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  Reflect.set(ctx.loader, 'internal', {
    version: 'v2',
    async import(specifier: string) {
      if (specifier === '@deepseek-ai/dsh-fantasy-yahoo') return YahooFantasyService
      if (specifier === '@deepseek-ai/dsh-tool-fantasy') return ToolFantasy
      throw new Error(`unexpected Loader import: ${specifier}`)
    },
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  expect(ctx.fantasy).toBeInstanceOf(YahooFantasyService)
  expect(ctx.tools.schemas().map(schema => schema.name)).toContain('fantasy')
  const entry = [...ctx.loader.entries()].find(row => row.options.name === '@deepseek-ai/dsh-tool-fantasy')
  await entry?.fiber?.dispose()
  expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('fantasy')
})
