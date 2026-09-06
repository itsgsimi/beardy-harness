import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Inbox } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as toolMemory from '../src/index.ts'

const testSignal = new AbortController().signal
const tempDirs: string[] = []

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-home-'))
  tempDirs.push(dir)
  return dir
}

function fakeAgent(id: string): Agent {
  const sessionId = SessionId(id)
  const session = Session.create(sessionId)
  return {
    id: sessionId,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** Mount the plugin over a real local filesystem rooted at the temp home. */
type Overrides = Partial<{
  userMaxChars: number
  memoryMaxChars: number
  entryMaxChars: number
  requireApproval: boolean
}>

async function setup(overrides: Overrides = {}): Promise<{ ctx: Context; root: string }> {
  const root = await home()
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(toolMemory, { dshHome: root, ...overrides })
  return { ctx, root }
}

function call(ctx: Context, arguments_: Record<string, unknown>, agent?: Agent) {
  return ctx.tools.execute({
    signal: testSignal,
    callId: ToolCallId(`memory-${Math.random().toString(36).slice(2)}`),
    name: 'memory',
    arguments: arguments_,
    ...(agent === undefined ? {} : { agent }),
  })
}

describe('memory tool', () => {
  it('registers the memory tool and its prompt section', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['memory'])
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.map(section => section.name)).toContain('tool:memory')
  })

  it('does not register the tool when no filesystem provider is mounted', async () => {
    const root = await home()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(toolMemory, { dshHome: root })
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('creates USER.md on the first add and reports the budget', async () => {
    const { ctx, root } = await setup()
    const result = await call(ctx, { target: 'user', action: 'add', content: 'User runs fish shell.' }, fakeAgent('m1'))
    expect(result.isError).toBe(false)
    expect(await readFile(join(root, 'USER.md'), 'utf8')).toBe('- User runs fish shell.\n')
    const observed = result.content[0]
    expect(observed?.type === 'text' && observed.text).toContain('now holds 1 entry (24 of 1375 characters)')
  })

  it('appends, replaces, and removes entries in MEMORY.md through version-checked writes', async () => {
    const { ctx, root } = await setup()
    await call(ctx, { target: 'memory', action: 'add', content: 'Repo uses pnpm.' }, fakeAgent('m2'))
    await call(ctx, { target: 'memory', action: 'add', content: 'Gates run under node 22.' }, fakeAgent('m2'))
    expect(await readFile(join(root, 'MEMORY.md'), 'utf8'))
      .toBe('- Repo uses pnpm.\n- Gates run under node 22.\n')
    const replaced = await call(ctx, {
      target: 'memory', action: 'replace', old_text: 'pnpm', content: 'Repo uses pnpm workspaces.',
    }, fakeAgent('m2'))
    expect(replaced.isError).toBe(false)
    await call(ctx, { target: 'memory', action: 'remove', old_text: 'node 22' }, fakeAgent('m2'))
    expect(await readFile(join(root, 'MEMORY.md'), 'utf8')).toBe('- Repo uses pnpm workspaces.\n')
  })

  it('refuses a symbolic-link target without touching its referent', async () => {
    const { ctx, root } = await setup()
    const outside = join(root, 'outside.txt')
    await writeFile(outside, 'do not touch\n')
    await symlink(outside, join(root, 'USER.md'))
    const result = await call(ctx, { target: 'user', action: 'add', content: 'x' }, fakeAgent('m3'))
    expect(result.isError).toBe(true)
    expect(await readFile(outside, 'utf8')).toBe('do not touch\n')
  })

  it('refuses to overwrite a hand-edited file that does not round-trip', async () => {
    const { ctx, root } = await setup()
    await writeFile(join(root, 'USER.md'), '# Profile\n- User runs fish shell.\n')
    const result = await call(ctx, { target: 'user', action: 'add', content: 'extra' }, fakeAgent('m4'))
    expect(result.isError).toBe(true)
    expect(await readFile(join(root, 'USER.md'), 'utf8')).toBe('# Profile\n- User runs fish shell.\n')
  })

  it('reports the overage and leaves the file untouched when a write exceeds the cap', async () => {
    const { ctx, root } = await setup({ memoryMaxChars: 30, entryMaxChars: 25 })
    await writeFile(join(root, 'MEMORY.md'), '- existing note\n')
    const result = await call(ctx, {
      target: 'memory', action: 'add', content: 'a fact that is definitely far too long for this cap',
    }, fakeAgent('m5'))
    expect(result.isError).toBe(true)
    expect(await readFile(join(root, 'MEMORY.md'), 'utf8')).toBe('- existing note\n')
  })

  it('refuses the write when no approval service is mounted', async () => {
    const { ctx, root } = await setup({ requireApproval: true })
    const result = await call(ctx, { target: 'user', action: 'add', content: 'needs approval' }, fakeAgent('m6'))
    expect(result.isError).toBe(true)
    expect(await readFile(join(root, 'USER.md')).catch(() => undefined)).toBeUndefined()
  })

  it('refuses the write when the agent cannot be named for approval', async () => {
    const { ctx } = await setup({ requireApproval: true })
    const result = await call(ctx, { target: 'user', action: 'add', content: 'x' })
    expect(result.isError).toBe(true)
  })

  it('writes when approval grants and refuses when it rejects', async () => {
    for (const outcome of ['allowed-once', 'rejected'] as const) {
      const root = await home()
      const reasons: string[] = []
      const ctx = new Context()
      ctx.provide('approval' as never, {
        request: async (req: { reason?: string }) => {
          reasons.push(req.reason ?? '')
          return outcome
        },
      } as never)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(LocalFileSystem, { cwd: root })
      await ctx.plugin(toolMemory, { dshHome: root, requireApproval: true })
      const longContent = `long fact ${'y'.repeat(150)}`
      const result = outcome === 'allowed-once'
        ? await call(ctx, { target: 'user', action: 'add', content: longContent }, fakeAgent('m-allowed'))
        : await (async () => {
          await writeFile(join(root, 'USER.md'), '- quick note\n')
          return await call(ctx, { target: 'user', action: 'remove', old_text: 'quick note' }, fakeAgent('m-rejected'))
        })()
      expect(result.isError).toBe(outcome === 'rejected')
      const text = await readFile(join(root, 'USER.md'), 'utf8')
      if (outcome === 'allowed-once') {
        expect(text).toContain('long fact')
        expect(reasons[0]).toContain('Write to USER.md: add entry "long fact')
        expect(reasons[0]).toContain('…')
      } else {
        expect(text).toBe('- quick note\n')
        expect(reasons[0]).toBe('Write to USER.md: remove entry matching "quick note"')
      }
    }
  })

  it('emits fs/observed before and after the write', async () => {
    const { ctx } = await setup()
    const seen: string[] = []
    ctx.on('fs/observed', (_target, state) => {
      seen.push(state.kind)
    })
    await call(ctx, { target: 'memory', action: 'add', content: 'observed note' }, fakeAgent('m7'))
    expect(seen).toEqual(['absent', 'present'])
  })

  it('honors every explicit configuration value', async () => {
    const { ctx, root } = await setup({ userMaxChars: 60, memoryMaxChars: 80, entryMaxChars: 40, requireApproval: false })
    const result = await call(ctx, { target: 'user', action: 'add', content: 'Explicit caps work.' }, fakeAgent('m8'))
    expect(result.isError).toBe(false)
    const observed = result.content[0]
    expect(observed?.type === 'text' && observed.text).toContain('(22 of 60 characters)')
    expect(await readFile(join(root, 'USER.md'), 'utf8')).toBe('- Explicit caps work.\n')
  })

  it('presents the call with the action and target', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.get('memory')?.presentCall?.({ target: 'memory', action: 'remove', old_text: 'note' })).toEqual({
      card: 'generic',
      title: 'memory remove (memory)',
      kind: 'delete',
      rawInput: 'note',
    })
    expect(ctx.tools.get('memory')?.presentCall?.({ target: 'user', action: 'add', content: 'note' })).toEqual({
      card: 'generic',
      title: 'memory add (user)',
      kind: 'execute',
      rawInput: 'note',
    })
  })

  it('rejects caps that cannot hold one entry at load', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(toolMemory, { userMaxChars: 5, memoryMaxChars: 20, entryMaxChars: 10 }))
      .rejects.toThrow('entryMaxChars must fit inside both file caps')
  })
})
