/** Explicit deliveries commit only after a successful final tool result. */
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { PresentedFile } from '../src/types.ts'
import * as Present from '../src/index.ts'

const cleanups: Array<() => Promise<unknown>> = []
let callNumber = 0
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
  vi.restoreAllMocks()
})
async function agent(ctx: Context, cwd: string | undefined): Promise<Agent> {
  const id = SessionId(`present-owner-${++callNumber}`)
  let scope: Scope
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION, id, createdAt: 0, ...cwd === undefined ? {} : { cwd }, isSeeded: false,
  })
  const value: Agent = {
    id,
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'idle',
    get ctx() { return scope.ctx },
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, value) }, { inject: ['tools'] }))
  await ctx.agents.register(value)
  return value
}


async function setup(maxVisualBytes = 8192) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-present-minimal-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  const fiber = ctx.plugin(Present, { maxFiles: 2, maxVisualBytes })
  await fiber
  const owner = await agent(ctx, root)
  owner.session.append('turn/start', { turn: 1 })
  const execute = (files: unknown) => ctx.tools.execute({
    signal: new AbortController().signal, callId: ToolCallId(`call-${++callNumber}`),
    name: 'present', arguments: { files }, agent: owner,
  })
  const visual = (path: string, description = 'The chart explains the measured results.') => ctx.tools.execute({
    signal: new AbortController().signal, callId: ToolCallId(`call-${++callNumber}`),
    name: 'present_visual', arguments: { path, title: 'Measured results', description }, agent: owner,
  })
  return { ctx, owner, root, fiber, execute, visual }
}

describe('present', () => {
  it('declares binary files without reading or copying contents, and records one delivery', async () => {
    const { ctx, owner, root, execute, fiber } = await setup()
    const data = Uint8Array.of(80, 75, 0, 255)
    await writeFile(join(root, '报告.docx'), data)
    const read = vi.spyOn(ctx.fs, 'readBytes')
    const result = await execute([{ path: '报告.docx', description: 'Report' }])
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('present failed')
    const files = (result.value as unknown as { files: PresentedFile[] }).files
    expect(files).toHaveLength(1)
    expect(owner.session.snapshotEvents().find(event => event.type === 'deliverables/presented')?.data.files).toEqual(files)
    expect(files).toEqual([{ path: '报告.docx', description: 'Report' }])
    expect(read).not.toHaveBeenCalled()
    expect(ctx.get('attachments')).toBeUndefined()
    await fiber.dispose()
    expect(ctx.tools.get('present', owner)).toBeUndefined()
  })

  it('ignores a different present definition in the calling agent scope', async () => {
    const { owner, execute } = await setup()
    owner.ctx.tools.register(defineTool({
      name: 'present', description: 'Scoped replacement.', parameters: {},
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            turn: { type: 'integer', required: true },
            files: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
        render: () => [],
      },
      execute: async () => ({ turn: 1, files: [] }),
    }))
    expect((await execute([])).isError).toBe(false)
    expect(owner.session.snapshotEvents().filter(event => event.type === 'deliverables/presented')).toEqual([])
  })

  it('records once when ancestor and agent scopes both mount present', async () => {
    const { owner, root, execute } = await setup()
    await owner.ctx.plugin(Present, { maxFiles: 2, maxVisualBytes: 8192 })
    await writeFile(join(root, 'a'), 'a')
    expect((await execute([{ path: 'a' }])).isError).toBe(false)
    const deliveries = owner.session.snapshotEvents().filter(event => event.type === 'deliverables/presented')
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]?.data.files[0]?.path).toBe('a')
  })

  it('does not publish deliveries after post-execute blocks a successful declaration', async () => {
    const { ctx, root, owner, execute } = await setup()
    await writeFile(join(root, 'a'), 'a')
    ctx.on('tools/post-execute', async (_exec, _result, next) => {
      await next()
      return { kind: 'block', feedback: [{ type: 'text', text: 'blocked' }] }
    })
    expect((await execute([{ path: 'a' }])).isError).toBe(true)
    expect(owner.session.snapshotEvents().some(event => event.type === 'deliverables/presented')).toBe(false)
  })

  it('rejects missing, non-file, empty, and excessive inputs', async () => {
    const { root, owner, execute } = await setup()
    await writeFile(join(root, 'large'), 'four')
    await symlink(tmpdir(), join(root, 'outside'))
    for (const files of [[], [{ path: '' }], [{ path: 'missing' }], [{ path: '.' }], [{ path: 'outside' }], [{ path: 'large' }, { path: 'large' }, { path: 'large' }]]) {
      const result = await execute(files)
      expect(result.isError, JSON.stringify(files)).toBe(true)
    }
    expect(owner.session.snapshotEvents().some(event => event.type === 'deliverables/presented')).toBe(false)
  })


})


it('validates deployment limits before registering the tool', () => {
  for (const config of [{ maxFiles: 0 }, { maxFiles: 1.5 }, { maxFiles: Number.POSITIVE_INFINITY }]) {
    expect(() => { Present.apply(new Context(), { ...config, maxVisualBytes: 8192 }) }).toThrow('positive integer maxFiles')
  }
  for (const maxVisualBytes of [0, 1.5, Number.POSITIVE_INFINITY]) {
    expect(() => { Present.apply(new Context(), { maxFiles: 2, maxVisualBytes }) }).toThrow('positive integer maxVisualBytes')
  }
})

describe('present_visual', () => {
  it('requires nonblank presentation details and a workspace in an open agent turn', async () => {
    const { ctx, owner, root } = await setup()
    await writeFile(join(root, 'chart.svg'), '<svg/>')
    const args = { path: 'chart.svg', title: 'Measured results', description: 'Findings.' }
    const invoke = (arguments_: typeof args, agent_: Agent | undefined = owner) => ctx.tools.execute({
      signal: new AbortController().signal, callId: ToolCallId(`visual-context-${++callNumber}`),
      name: 'present_visual', arguments: arguments_, ...agent_ === undefined ? {} : { agent: agent_ },
    })
    for (const field of ['path', 'title', 'description']) {
      expect((await invoke({ ...args, [field]: ' ' })).isError).toBe(true)
    }
    const detached = await ctx.tools.execute({
      signal: new AbortController().signal, callId: ToolCallId('visual-detached'),
      name: 'present_visual', arguments: args,
    })
    expect(detached.isError).toBe(true)
    const noWorkspace = await agent(ctx, undefined)
    noWorkspace.session.append('turn/start', { turn: 1 })
    expect((await invoke(args, noWorkspace)).isError).toBe(true)
    const noTurn = await agent(ctx, root)
    expect((await invoke(args, noTurn)).isError).toBe(true)
    owner.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect((await invoke(args)).isError).toBe(true)
    expect(owner.session.snapshotEvents().some(event => event.type === 'deliverables/presented')).toBe(false)
  })

  it.each(['chart.svg', 'mockup.html', 'animation.gif', 'screenshot.png', 'photo.jpg', 'chart.webp'])(
    'preserves original %s bytes outside model content and survives source deletion', async (path) => {
      const { root, visual, owner, ctx, fiber } = await setup()
      const bytes = Buffer.from(path.endsWith('.svg') ? '<svg xmlns="http://www.w3.org/2000/svg"><text>图表</text></svg>' : 'original bytes')
      await writeFile(join(root, path), bytes)
      const result = await visual(path)
      expect(result.isError).toBe(false)
      expect(result.content).toEqual([{ type: 'text', text: `Presented visual: Measured results (${path})` }])
      const events = owner.session.snapshotEvents()
      const delivery = events.find(event => event.type === 'deliverables/presented')
      expect(delivery?.data.files[0]?.visual?.data).toBe(bytes.toString('base64'))
      expect(JSON.stringify(result)).not.toContain(bytes.toString('base64'))
      await rm(join(root, path))
      expect(Session.create(SessionId('visual-replay'), events).snapshotEvents().find(event => event.type === 'deliverables/presented')).toEqual(delivery)
      await fiber.dispose()
      expect(ctx.tools.get('present_visual', owner)).toBeUndefined()
    },
  )

  it('bounds the complete serialized delivery including base64 and multibyte captions', async () => {
    const { root, visual, owner } = await setup(256)
    await writeFile(join(root, 'chart.svg'), '<svg/>')
    expect((await visual('chart.svg', '图'.repeat(100))).isError).toBe(true)
    expect(owner.session.snapshotEvents().some(event => event.type === 'deliverables/presented')).toBe(false)
  })

  it('rejects oversized, unsupported, empty, and invalid UTF-8 files', async () => {
    const { root, visual, owner } = await setup(256)
    for (const [path, data] of [['large.gif', Buffer.alloc(257)], ['code.js', Buffer.from('x')],
      ['empty.svg', Buffer.alloc(0)], ['invalid.html', Buffer.from([0xff])]] as const) {
      await writeFile(join(root, path), data)
      expect((await visual(path)).isError).toBe(true)
    }
    expect((await visual('missing.svg')).isError).toBe(true)
    await symlink(join(root, 'large.gif'), join(root, 'link.gif'))
    expect((await visual('link.gif')).isError).toBe(true)
    expect(owner.session.snapshotEvents().some(event => event.type === 'deliverables/presented')).toBe(false)
  })

  it('publishes nothing when final policy blocks the visual result', async () => {
    const { ctx, root, owner, visual } = await setup()
    await writeFile(join(root, 'chart.svg'), '<svg/>')
    ctx.on('tools/post-execute', async (_exec, _result, next) => {
      await next()
      return { kind: 'block', feedback: [{ type: 'text', text: 'blocked' }] }
    })
    expect((await visual('chart.svg')).isError).toBe(true)
    expect(owner.session.snapshotEvents().some(event => event.type === 'deliverables/presented')).toBe(false)
  })
})

it('requires an agent, an open turn, and a workspace', async () => {
  const { ctx, owner, execute } = await setup()
  const detached = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('detached'), name: 'present', arguments: { files: [{ path: 'a' }] } })
  expect(detached.isError).toBe(true)
  owner.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect((await execute([{ path: 'a' }])).isError).toBe(true)
  const noWorkspace = await agent(ctx, undefined)
  noWorkspace.session.append('turn/start', { turn: 1 })
  const absent = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('no-workspace'), name: 'present', arguments: { files: [{ path: 'a' }] }, agent: noWorkspace })
  expect(absent.isError).toBe(true)
})


it('declares readable files outside the Session directory using absolute and relative paths', async () => {
  const { root, execute, owner } = await setup()
  const outside = await mkdtemp(join(tmpdir(), 'dsh-present-external-'))
  cleanups.push(() => rm(outside, { recursive: true, force: true }))
  const file = join(outside, 'report.txt')
  await writeFile(file, 'external report')
  const files = [{ path: file }, { path: relative(root, file) }]
  expect((await execute(files)).isError).toBe(false)
  expect(owner.session.snapshotEvents().find(event => event.type === 'deliverables/presented')?.data.files).toEqual(files)
})

it('refuses a final symlink to an ordinary file', async () => {
  const { root, execute } = await setup()
  await writeFile(join(root, 'source'), 'source')
  await symlink(join(root, 'source'), join(root, 'link'))
  expect((await execute([{ path: 'link' }])).isError).toBe(true)
})


it('refuses a file replaced by a directory after inspecting its final component', async () => {
  const { ctx, root, execute } = await setup()
  await writeFile(join(root, 'source'), 'source')
  const directory = await ctx.fs.stat(await ctx.fs.resolve(root))
  vi.spyOn(ctx.fs, 'stat').mockResolvedValueOnce(directory)
  expect((await execute([{ path: 'source' }])).isError).toBe(true)
})
