// Boots a cordis.yml through the real Loader to prove the tool reaches the model-facing schema list,
// posts through the production transport, and refuses unusable configuration at load.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
import * as ToolDiscord from '@deepseek-ai/dsh-tool-discord'

const CHANNEL = '1478276183543119914'

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
      resolve: async (ref: string) => (ref === 'DSH_DISCORD_BOT_TOKEN'
        ? { value: 'fixture-token', source: 'fixture' }
        : undefined),
    } as never)
  },
}

function agent(ctx: Context): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId('discord-loader-agent')
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
 * Boot a cordis.yml carrying the given tool-discord config block.
 * @param configLines - YAML lines nested under the plugin's `config:` key.
 * @returns the booted context.
 */
async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-discord-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- name: fixture-credentials',
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-discord'",
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
    ['@deepseek-ai/dsh-agent', AgentRegistry],
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
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  // The Loader is non-transactional: an entry whose apply threw stays inactive
  // and its failure is reported on its own fiber, so join them here to keep
  // this helper rejecting for a composition the plugin refuses.
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}

const VALID_CONFIG = ['    tokenEnv: DSH_DISCORD_BOT_TOKEN', `    channelId: '${CHANNEL}'`]

describe('tool-discord real Loader composition through cordis.yml', () => {
  it('exposes discord_send with the fixed-destination contract', async () => {
    const ctx = await boot(VALID_CONFIG)
    const schema = ctx.tools.schemas().find(entry => entry.name === 'discord_send')
    expect(schema?.description).toContain('The only destination is the configured channel')
    expect(Object.keys(schema?.parameters.properties ?? {})).toEqual(['content'])
  }, 60_000)

  it('posts a message through the production transport', async () => {
    const ctx = await boot(VALID_CONFIG)
    const requests: { url: string; body?: string | undefined; authorization?: string | undefined }[] = []
    vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: typeof init?.body === 'string' ? init.body : undefined,
        authorization: (init?.headers as Record<string, string>).authorization,
      })
      return Promise.resolve(new Response('{"id":"7"}', { status: 200 }))
    })

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('brief'),
      name: 'discord_send',
      arguments: { content: 'Morning brief: sunny, 4 posts.' },
      agent: agent(ctx),
    })

    expect(result.isError).toBe(false)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe(`https://discord.com/api/v10/channels/${CHANNEL}/messages`)
    expect(requests[0]?.authorization).toBe('Bot fixture-token')
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
      content: 'Morning brief: sunny, 4 posts.',
      allowed_mentions: { parse: [] },
    })
  }, 60_000)

  it.each([
    { label: 'omitted', lines: [`    channelId: '${CHANNEL}'`], failure: /tokenEnv missing required value/ },
    { label: 'not a snowflake', lines: ['    tokenEnv: DSH_DISCORD_BOT_TOKEN', '    channelId: "chat"'], failure: /channelId must be a Discord snowflake/ },
  ])('fails loading when channelId or tokenEnv is $label', async ({ lines, failure }) => {
    await expect(boot(lines)).rejects.toThrow(failure)
  }, 60_000)
})
