// Boots a cordis.yml through the real Loader to prove tool-memory mounts over the local filesystem,
// writes USER.md end-to-end, and refuses caps that cannot hold one entry at load.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as ToolMemory from '@deepseek-ai/dsh-tool-memory'

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
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return { ctx, home }
}

describe('tool-memory real Loader composition through cordis.yml', () => {
  it('exposes the memory tool with the two fixed targets', async () => {
    const { ctx } = await boot()
    const schema = ctx.tools.schemas().find(entry => entry.name === 'memory')
    expect(schema?.description).toContain('USER.md')
    expect(Object.keys(schema?.parameters.properties ?? {}))
      .toEqual(['target', 'action', 'content', 'old_text'])
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
})
