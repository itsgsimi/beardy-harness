import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as Health from '../src/index.ts'

describe('health Loader composition', () => {
  it('mounts the empty Beardy probe list without an endpoint or Discord credential', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-health-loader-'))
    const ctx = new Context()
    try {
      const accepted = vi.fn((): true => true)
      ctx.on('cron/run-finished', accepted)
      const path = join(root, 'cordis.yml')
      await writeFile(path, "- name: '@deepseek-ai/dsh-health'\n  config:\n    probes: []\n")
      ctx.baseUrl = pathToFileURL(root).href + '/'
      await ctx.plugin(Loader)
      ctx.loader.builtins.include = Include
      ctx.loader.internal = { version: 'v2',
        import: async (specifier: string) => {
          if (specifier !== '@deepseek-ai/dsh-health') throw new Error(`unexpected plugin: ${specifier}`)
          return Health
        },
      } as never
      ctx.provide('credentials', { resolve: async () => undefined } as never)
      await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
      await ctx.loader.await()
      for (const entry of ctx.loader.entries()) await entry.fiber?.await()
      expect(ctx.get('healthStatus')?.snapshot()).toEqual({ probes: [] })
      await expect(ctx.serial('cron/run-finished', { jobName: 'brief', sessionId: 's1', firedAt: 1,
        outcome: 'failed', text: '', reportOutcome: true, failure: { code: 'TRANSPORT', message: 'private' } })).resolves.toBe(true)
      expect(accepted).toHaveBeenCalledTimes(1)
      expect(ctx.get('healthStatus')?.snapshot().lastCronFailure).toEqual({ jobName: 'brief', sessionId: 's1', code: 'TRANSPORT' })
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
  it('reads an unquoted Signal group target with "+" and "=" from YAML unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-health-loader-'))
    const ctx = new Context()
    try {
      const target = 'signal:group:1QtO3Hub7LE5w2ErIhBrS+WLYdHawvpk03PJMnYREh8='
      const path = join(root, 'cordis.yml')
      await writeFile(path, `- name: '@deepseek-ai/dsh-health'\n  config:\n    noticeChannelId: ${target}\n`)
      ctx.baseUrl = pathToFileURL(root).href + '/'
      await ctx.plugin(Loader)
      ctx.loader.builtins.include = Include
      ctx.loader.internal = { version: 'v2', import: async () => Health } as never
      ctx.provide('credentials', { resolve: async () => undefined } as never)
      await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
      await ctx.loader.await()
      for (const entry of ctx.loader.entries()) await entry.fiber?.await()
      expect(ctx.get('healthStatus')?.snapshot()).toEqual({ probes: [] })
      const [entry] = [...ctx.loader.entries()].filter(item => item.options.name === '@deepseek-ai/dsh-health')
      expect(entry?.options.config).toEqual({ noticeChannelId: target })
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
