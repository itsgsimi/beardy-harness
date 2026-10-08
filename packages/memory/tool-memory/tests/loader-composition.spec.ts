// Boots real Loader compositions for local and approved sandboxed memory writes,
// including Web, Discord, and cron approval routes against temporary homes.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import UserApproval from '@deepseek-ai/dsh-user-approval'
import { createJobRunner, registerCronApprovalRoute } from '@deepseek-ai/dsh-cron'
import * as ToolMemory from '@deepseek-ai/dsh-tool-memory'
import { GUILD_CHANNEL, USER, drain, harness, inbound } from '../../../discord/discord-gateway/tests/support.ts'
import { approvalAsksProjection } from '../../../discord/discord-gateway/src/approval-asks.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function agent(): Agent {
  const id = SessionId('memory-loader-agent')
  const session = Session.create(id)
  session.append('turn/start', { turn: 1 })
  return {
    id, options: {}, session,
    inbox: unsupportedInbox(),
    status: 'idle', ctx: new Context(),
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/**
 * Boot a cordis.yml carrying a temp-home-derived tool-memory config block.
 * @param configForRoot - builds the YAML lines nested under `config:` from the fresh temp home.
 * @returns the booted context and the temp home it was configured with.
 */
async function boot(configForRoot?: (root: string) => readonly string[]): Promise<{ ctx: Context; home: string }> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-memory-loader-'))
  root = home
  const configLines = configForRoot?.(home) ?? []
  const configPath = join(home, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-fs-local'",
    '  config:',
    `    cwd: ${home}`,
    "- name: '@deepseek-ai/dsh-tool-memory'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(home).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
    ['@deepseek-ai/dsh-tool-memory', ToolMemory],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2',
    loadCache: new Map(),
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
  } satisfies ModuleLoaderV2
  ctx.loader.internal = internal
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  // The Loader is non-transactional: an entry whose apply threw stays inactive
  // and its failure is reported on its own fiber, so join them here to keep
  // this helper rejecting for a composition the plugin refuses.
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return { ctx, home }
}

/** Boot the production policy, filesystem, approval, and memory plugins over sibling temp home and workspace paths. */
async function bootApproved(): Promise<{ ctx: Context; home: string; workspace: string }> {
  await mkdir(join(process.cwd(), '.cache'), { recursive: true })
  const container = await mkdtemp(join(process.cwd(), '.cache', 'dsh-approved-home-'))
  root = container
  const home = join(container, 'home')
  const workspace = join(container, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  const configPath = join(container, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-sandbox-policy'",
    '  config:',
    '    mode: workspace-write',
    `    workspaceRoot: ${workspace}`,
    "- name: '@deepseek-ai/dsh-fs-sandbox'",
    "- name: '@deepseek-ai/dsh-user-approval'",
    "- name: '@deepseek-ai/dsh-tool-memory'",
    '  config:',
    `    dshHome: ${home}`,
    '    requireApproval: true',
    '    allowApprovedHomeWrites: true',
    '',
  ].join('\n'))
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(container).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session-projection', SessionProjections],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-sandbox-policy', SandboxPolicy],
    ['@deepseek-ai/dsh-fs-sandbox', SandboxedFileSystem],
    ['@deepseek-ai/dsh-user-approval', UserApproval],
    ['@deepseek-ai/dsh-tool-memory', ToolMemory],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2', loadCache: new Map(),
    import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
  ctx.loader.internal = internal
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return { ctx, home, workspace }
}

function writeCore(ctx: Context, liveAgent: Agent, content: string) {
  return ctx.tools.execute({
    signal: new AbortController().signal, callId: ToolCallId(`approved-${content}`),
    name: 'memory', arguments: { target: 'user', action: 'add', content }, agent: liveAgent,
  })
}

describe('tool-memory real Loader composition through cordis.yml', () => {
  it('answers an actual cron runner turn through the Discord gateway before its home write', { timeout: 60_000 }, async () => {
    const { ctx, home, workspace } = await bootApproved()
    let toolResult: Awaited<ReturnType<typeof writeCore>> | undefined
    let toolError: string | undefined
    let cronSession: Session | undefined
    ctx.provide('agentDefaultModel' as never, { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) } as never)
    ctx.provide('permissionPresets' as never, { resolve: () => ({}), set: () => {} } as never)
    ctx.provide('agentPresets' as never, {
      resolve: async (name: string) => ({ id: name }),
      acquireScope: async () => ({ [Symbol.asyncDispose]: async () => {} }),
      mount: async () => {},
    } as never)
    ctx.provide('workspaceRegistry' as never, { create: async (path: string) => ({
      path, attachSession: async () => {}, detachSession: async () => {},
    }) } as never)
    ctx.provide('sessionTitle' as never, { rename: () => {} } as never)
    ctx.provide('agents' as never, { create: async (options: {
      sessionId: ReturnType<typeof SessionId>
      setup?: (agentCtx: Context, liveAgent: Agent) => Promise<void>
    }) => {
      const session = Session.create(options.sessionId)
      cronSession = session
      session.append('turn/start', { turn: 1 })
      let settle = (): void => {}
      const idle = new Promise<void>((resolve) => { settle = resolve })
      const liveAgent: Agent = {
        id: options.sessionId, session, options: {}, inbox: unsupportedInbox(), status: 'running', ctx,
        followup: () => {
          void writeCore(ctx, liveAgent, 'Cron runner approved home write.').then((result) => {
            toolResult = result
            session.append('assistant/message', { stream: [], turn: 1, step: 1,
              message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'Saved.' }],
                source: { kind: 'model', provider: 'fixture', model: 'fixture' } }),
            }, { surfaceOp: 'append' })
            session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
          }).catch((error: unknown) => { toolError = String(error) }).finally(settle)
        },
        whenIdle: () => idle, send: () => {}, steer: () => {}, inject: () => {}, cancel() {},
        runMaintenance: task => task(new AbortController().signal),
      }
      await options.setup?.(ctx, liveAgent)
      return { agent: liveAgent, dispose: async () => {} }
    } } as never)

    // The gateway plugin registers this fold at load; the router harness leaves it to the caller.
    ctx.sessionProjections.register(approvalAsksProjection)
    const gateway = harness({ eventContext: ctx, answerers: ['reaction'] })
    const runner = createJobRunner({ ctx, signal: new AbortController().signal, turnTimeoutMs: 10_000,
      wait: () => new Promise<void>(() => {}) })
    try {
      const run = runner.run({ name: 'approved-memory', expression: '0 7 * * *', timezone: 'UTC',
        prompt: 'Remember this fact.', agentPreset: 'beardy', permissionPreset: 'workspace-write',
        workspacePath: workspace, notes: '', deliverChannelId: GUILD_CHANNEL,
      }, Date.parse('2026-09-27T07:00:00.000Z'), SessionId('cron-approved-memory'))
      await drain()
      expect(gateway.prompts.at(-1)?.channelId).toBe(GUILD_CHANNEL)
      gateway.router.handleReaction({ userId: USER, channelId: GUILD_CHANNEL, messageId: 'prompt-1', emojiName: '✅' })
      expect(await run).toMatchObject({ outcome: 'answered', text: 'Saved.' })
      expect(toolError).toBeUndefined()
      expect(toolResult?.isError).toBe(false)
      expect(await readFile(join(home, 'USER.md'), 'utf8')).toBe('- Cron runner approved home write.\n')
      const asked = cronSession?.ownEvents().find(event => event.type === 'approval/asked')
      const decided = cronSession?.ownEvents().find(event => event.type === 'approval/decided')
      expect(asked?.type === 'approval/asked' && decided?.type === 'approval/decided'
        && asked.data.id === decided.data.id && decided.data.outcome === 'allowed-once').toBe(true)
    } finally {
      await runner.dispose()
      await gateway.router.dispose()
    }
  })

  it('writes from Web and Discord workspace-write Sessions and routes a cron approval through the gateway', { timeout: 60_000 }, async () => {
    const { ctx, home } = await bootApproved()
    const web = agent()
    const removeWebAnswerer = ctx.on('approval/request', async (_request, next) => {
      if (_request.agent === web) return 'allowed-once'
      return next()
    })
    const webResult = await writeCore(ctx, web, 'Web approved home write.')
    if (webResult.isError) throw new Error(JSON.stringify(webResult.content))
    expect(web.session.ownEvents().map(event => event.type)).toContain('approval/decided')
    removeWebAnswerer()

    const discord = agent()
    // The gateway plugin registers this fold at load; the router harness leaves it to the caller.
    ctx.sessionProjections.register(approvalAsksProjection)
    const gateway = harness({ eventContext: ctx, approvalAgent: discord, answerers: ['reaction', 'text'] })
    try {
      gateway.router.handle(inbound({ channelId: GUILD_CHANNEL, guildId: GUILD_CHANNEL }))
      await drain()
      const discordWrite = writeCore(ctx, discord, 'Discord approved home write.')
      await drain()
      expect(gateway.prompts.at(-1)?.channelId).toBe(GUILD_CHANNEL)
      gateway.router.handleReaction({ userId: USER, channelId: GUILD_CHANNEL, messageId: 'prompt-1', emojiName: '✅' })
      expect((await discordWrite).isError).toBe(false)
      expect(discord.session.ownEvents().map(event => event.type)).toContain('approval/decided')

      const cron = agent()
      const release = registerCronApprovalRoute(cron, GUILD_CHANNEL)
      try {
        const cronWrite = writeCore(ctx, cron, 'Cron approved home write.')
        await drain()
        expect(gateway.prompts.at(-1)?.channelId).toBe(GUILD_CHANNEL)
        gateway.router.handleReaction({ userId: USER, channelId: GUILD_CHANNEL, messageId: 'prompt-1', emojiName: '✅' })
        expect((await cronWrite).isError).toBe(false)
        expect(cron.session.ownEvents().map(event => event.type)).toContain('approval/decided')
        const saved = await readFile(join(home, 'USER.md'), 'utf8')
        const rejected = writeCore(ctx, cron, 'Rejected cron write.')
        await drain()
        gateway.router.handleReaction({ userId: USER, channelId: GUILD_CHANNEL, messageId: 'prompt-1', emojiName: '❌' })
        expect((await rejected).isError).toBe(true)
        expect(await readFile(join(home, 'USER.md'), 'utf8')).toBe(saved)
      } finally { release() }
      expect(await readFile(join(home, 'USER.md'), 'utf8')).toBe('- Web approved home write.\n- Discord approved home write.\n- Cron approved home write.\n')
    } finally { await gateway.router.dispose() }
  })
  it('exposes core and topic actions through the same memory tool', async () => {
    const { ctx } = await boot()
    const schema = ctx.tools.schemas().find(entry => entry.name === 'memory')
    expect(schema?.description).toContain('USER.md')
    expect(Object.keys(schema?.parameters.properties ?? {}))
      .toEqual(['target', 'action', 'content', 'old_text', 'topic', 'expected_version', 'include_retired', 'superseded_by'])
  }, 60_000)

  it('writes USER.md under the configured home end-to-end', async () => {
    const { ctx, home } = await boot(homePath => [`    dshHome: ${homePath}`])
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('remember-fish'),
      name: 'memory',
      arguments: { target: 'user', action: 'add', content: 'User runs fish shell.' },
      agent: agent(),
    })
    expect(result.isError).toBe(false)
    expect(await readFile(join(home, 'USER.md'), 'utf8')).toBe('- User runs fish shell.\n')
  }, 60_000)

  it('refuses configuration whose entry cap exceeds a file cap at load', async () => {
    await expect(boot(() => ['    userMaxChars: 5', '    entryMaxChars: 10'])).rejects
      .toThrow('entryMaxChars must fit inside both file caps')
  }, 60_000)

  it('requires approval for home allowances at load', async () => {
    await expect(boot(() => ['    allowApprovedHomeWrites: true'])).rejects
      .toThrow('allowApprovedHomeWrites requires requireApproval')
  }, 60_000)

  it('bounds topic reads at load', async () => {
    await expect(boot(() => ['    topicMaxChars: 100', '    topicReadMaxChars: 101'])).rejects
      .toThrow('topicReadMaxChars must be no greater than topicMaxChars')
  }, 60_000)
})
