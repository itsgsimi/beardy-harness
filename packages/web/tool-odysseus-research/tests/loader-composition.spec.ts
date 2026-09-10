// Loader composition keeps the real registry, schema projection, and execution pipeline.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import FileSettings from '@deepseek-ai/dsh-settings-file'
import * as ToolResearch from '@deepseek-ai/dsh-tool-odysseus-research'


let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  vi.unstubAllGlobals()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Plugin supplying the credential reference value without a credentials provider on disk. */
const credentialFixtures = {
  name: 'fixture-credentials',
  apply(ctx: Context) {
    ctx.provide('credentials' as never, {
      resolve: async (ref: string) => (ref === 'ODYSSEUS_TOKEN'
        ? { value: 'fixture-token', source: 'fixture' }
        : undefined),
    } as never)
  },
}

function agent(ctx: Context): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId('odysseus-loader-agent')
  const session = Session.create(id)
  const value: Agent = {
    id, options: {}, session, inbox: unsupportedInbox(),
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

/**
 * Boot a cordis.yml carrying the given tool-odysseus-research config block.
 * @param configLines - YAML lines nested under the plugin's `config:` key.
 * @returns the booted context.
 */
async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-odysseus-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- name: fixture-credentials',
    "- name: '@deepseek-ai/dsh-settings-file'",
    '  config:',
    `    path: ${join(root, 'settings.yaml')}`,
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-odysseus-research'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['fixture-credentials', credentialFixtures],
    ['@deepseek-ai/dsh-settings-file', FileSettings],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-odysseus-research', ToolResearch],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

const VALID_CONFIG = [
  '    baseURL: http://odysseus.test', '    tokenEnv: ODYSSEUS_TOKEN', '    endpointId: worker-4b',
  '    model: Qwen3.5-4B', '    maxRounds: 1', '    maxTimeSeconds: 60',
]

it('loads the tool, executes with the configured worker, and removes it on disposal', async () => {
  const ctx = await boot(VALID_CONFIG)
  expect('default' in ToolResearch).toBe(false)
  const schema = ctx.tools.schemas().find(entry => entry.name === 'odysseus_research')
  expect(schema?.description).toContain('without consuming them')
  expect(schema?.parameters.properties).not.toHaveProperty('model')
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{"session_id":"rp-test","status":"running"}'))
  vi.stubGlobal('fetch', fetch)
  const result = await ctx.tools.execute({
    signal: new AbortController().signal, callId: ToolCallId('research'), name: 'odysseus_research',
    arguments: { action: 'start', query: 'Research test' }, agent: agent(ctx),
  })
  expect(result.isError, JSON.stringify(result)).toBe(false)
  expect(result.content).toEqual([{ type: 'text', text: '{"id":"rp-test","status":"running","model":"Qwen3.5-4B"}' }])
  expect((JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as { model: string }).model).toBe('Qwen3.5-4B')
  const entry = [...ctx.loader.entries()].find(item => item.options.name === '@deepseek-ai/dsh-tool-odysseus-research')!
  await entry.fiber!.dispose()
  expect(ctx.tools.schemas()).not.toContainEqual(expect.objectContaining({ name: 'odysseus_research' }))
})

it.each([
  ['    baseURL: ftp://example.org'], ['    maxRounds: 1.5'], ['    model: ""'],
])('rejects invalid deployment configuration: %j', async (extra) => {
  const field = extra.trim().split(':')[0]
  await expect(boot([...VALID_CONFIG.filter(line => line.trim().split(':')[0] !== field), extra])).rejects.toThrow()
})


it('uses the saved research model for new jobs and refuses unavailable selections', async () => {
  const ctx = await boot([...VALID_CONFIG,
    '    workers:', '      - id: flash', '        label: Flash', '        endpointId: flash-endpoint',
    '        model: flash-model', '        disableThinking: false',
  ])
  const namespace = ctx.settings.describe().find(item => item.ns === 'odysseus-research')!.ns
  await expect(ctx.settings.update(namespace, { worker: 'missing' })).rejects.toThrow()
  await ctx.settings.update(namespace, { worker: 'flash' })
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{"session_id":"rp-flash","status":"running"}'))
  vi.stubGlobal('fetch', fetch)
  const result = await ctx.tools.execute({
    signal: new AbortController().signal, callId: ToolCallId('selected-research'), name: 'odysseus_research',
    arguments: { action: 'start', query: 'Research test' }, agent: agent(ctx),
  })
  expect(result.content).toEqual([{ type: 'text', text: '{"id":"rp-flash","status":"running","model":"flash-model"}' }])
  expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toMatchObject({ endpoint_id: 'flash-endpoint', model: 'flash-model' })
})

it('retains a complete report artifact while the model receives a bounded page', async () => {
  const ctx = await boot([...VALID_CONFIG, '    pageChars: 8'])
  const markdown = '# Full report\n\nEvidence after the model page.'
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
    result: markdown, sources: [{ url: 'https://example.org', title: 'Evidence' }],
  }))))
  const result = await ctx.tools.execute({
    signal: new AbortController().signal, callId: ToolCallId('report'), name: 'odysseus_research',
    arguments: { action: 'report', id: 'rp-test' }, agent: agent(ctx),
  })
  expect(result.isError, JSON.stringify(result)).toBe(false)
  expect(result.meta).toEqual({ researchArtifact: { id: 'rp-test', markdown, sources: [{ url: 'https://example.org', title: 'Evidence' }] } })
  expect(JSON.stringify(result.content)).not.toContain('Evidence after the model page')
})
