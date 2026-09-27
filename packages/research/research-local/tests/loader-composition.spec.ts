import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import WebRuntime from '@deepseek-ai/dsh-web'
import LocalResearchService from '../src/index.ts'

let root: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  try {
    await ctx?.fiber.dispose()
  } finally {
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    ctx = undefined
    root = undefined
  }
})

it('mounts research-local through Loader and disposes its run agents', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-research-loader-'))
  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(LocalAttachmentStore, { dshHome: root })
  await ctx.plugin(WebRuntime)
  await ctx.plugin(AgentLoop, { agents: [] })
  const caller = await ctx.agents.create({ sessionId: SessionId('loader-research-caller') })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-research-local'",
    '  config:',
    '    provider: mock',
    '    model: test-model',
    '',
  ].join('\n'))
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  Reflect.set(ctx.loader, 'internal', {
    version: 'v2',
    async import(specifier: string) {
      if (specifier === '@deepseek-ai/dsh-research-local') return LocalResearchService
      throw new Error(`unexpected Loader import: ${specifier}`)
    },
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const provider = ctx.research
  expect(provider).toBeInstanceOf(LocalResearchService)
  if (!(provider instanceof LocalResearchService)) throw new Error('research provider was not mounted')
  const owner = { kind: 'session' as const, sessionId: caller.agent.session.id }
  const run = await provider.startStored({ caller: caller.agent.session, owner, query: 'Loader run' })
  expect(ctx.agents.get(SessionId(run.id))).toBeDefined()
  const entry = [...ctx.loader.entries()].find(row => row.options.name === '@deepseek-ai/dsh-research-local')
  expect(entry?.fiber).toBeDefined()
  await entry!.fiber!.dispose()
  expect(ctx.get('research')).toBeUndefined()
  expect(ctx.agents.get(SessionId(run.id))).toBeUndefined()
  await caller.dispose()
})
