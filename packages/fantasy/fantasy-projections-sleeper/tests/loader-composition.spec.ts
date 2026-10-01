import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SleeperProjectionService from '../src/index.ts'

let root: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  try { await ctx?.fiber.dispose() }
  finally {
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    root = undefined
    ctx = undefined
  }
})

it('mounts the provider with schema defaults through Loader and removes it on disposal', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-fantasy-projections-loader-'))
  ctx = new Context()
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, "- name: '@deepseek-ai/dsh-fantasy-projections-sleeper'\n  config:\n    cacheTtlMs: 0\n")
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  Reflect.set(ctx.loader, 'internal', {
    version: 'v2',
    async import(specifier: string) {
      if (specifier === '@deepseek-ai/dsh-fantasy-projections-sleeper') return SleeperProjectionService
      throw new Error(`unexpected Loader import: ${specifier}`)
    },
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  expect(ctx.fantasyProjections).toBeInstanceOf(SleeperProjectionService)
  expect(Reflect.get(ctx.fantasyProjections, 'config')).toMatchObject({ baseUrl: 'https://api.sleeper.com', cacheTtlMs: 0 })
  const entry = [...ctx.loader.entries()].find(row => row.options.name === '@deepseek-ai/dsh-fantasy-projections-sleeper')
  await entry?.fiber?.dispose()
  expect(ctx.get('fantasyProjections')).toBeUndefined()
})
