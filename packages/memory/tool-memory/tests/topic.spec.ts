import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import * as ToolMemory from '../src/index.ts'
import { parseTopic, topicVersion } from '../src/topic.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

function document(source = 'conversation', history = '- Learned from the owner.'): string {
  return `---\nupdated: 2026-09-27\nstatus: active\nsource: ${source}\nsuperseded-by: \n---\n\n# Household facts\n\n## Rule\nUse the side door.\n\n## Why\nThe front door sticks.\n\n## History\n${history}\n`
}

function versionOf(result: string): string {
  const version = /"version":"(sha256:[a-f0-9]+)"/.exec(result)?.[1]
  if (version === undefined) throw new Error('topic result has no version')
  return version
}

function topicCount(result: string): number {
  return result.match(/"slug":/g)?.length ?? 0
}

function agent(): Agent {
  const id = SessionId('topic-test')
  return {
    id, session: Session.create(id), options: {}, inbox: unsupportedInbox(), status: 'idle', ctx: new Context(),
    send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
  }
}

async function setup(config: Partial<ToolMemory.Config> = {}, withPolicy = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-topic-test-'))
  roots.push(root)
  const ctx = new Context()
  if (config.requireApproval === true) {
    ctx.provide('approval' as never, { request: async () => 'allowed-once' } as never)
  }
  await ctx.plugin(SystemPrompt)
  if (withPolicy) {
    await ctx.plugin(SessionProjections)
    await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: root })
  }
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(ToolMemory, { dshHome: root, ...config })
  const call = async (args: Record<string, unknown>) => {
    const result = await ctx.tools.execute({
      name: 'memory', arguments: args, callId: ToolCallId(`topic-${Math.random()}`),
      signal: new AbortController().signal, agent: agent(),
    })
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    return { error: result.isError, text }
  }
  return { root, call, ctx }
}

describe('on-demand topic memory', () => {
  it('round-trips three existing Markdown shapes and lists retired topics only on request', async () => {
    const { root, call } = await setup()
    const originals = [document(), document('user', '- Confirmed twice.\n- Still applies.'),
      document('migration', '- First observed in 2025.\n\nMore context stays here.')]
    await mkdir(join(root, 'memories'))
    for (const [index, body] of originals.entries()) {
      await writeFile(join(root, 'memories', `topic-${index}.md`), body)
    }
    const listed = await call({ target: 'topic', action: 'list' })
    expect(topicCount(listed.text)).toBe(3)
    for (const [index, body] of originals.entries()) {
      const read = await call({ target: 'topic', action: 'read', topic: `topic-${index}` })
      expect(read.text).toContain(`"body":${JSON.stringify(body)}`)
      expect(await readFile(join(root, 'memories', `topic-${index}.md`), 'utf8')).toBe(body)
    }
    const current = versionOf((await call({ target: 'topic', action: 'read', topic: 'topic-0' })).text)
    const retired = await call({ target: 'topic', action: 'remove', topic: 'topic-0', expected_version: current, superseded_by: 'topic-1' })
    expect(retired.error).toBe(false)
    const saved = await readFile(join(root, 'memories', 'topic-0.md'), 'utf8')
    expect(saved).toContain('status: retired')
    expect(saved).toContain('superseded-by: topic-1')
    expect(saved).toContain('## Rule\nUse the side door.')
    expect(saved).toContain('## Why\nThe front door sticks.')
    expect(saved).toContain('## History\n- Learned from the owner.')
    expect(topicCount((await call({ target: 'topic', action: 'list' })).text)).toBe(2)
    expect(topicCount((await call({ target: 'topic', action: 'list', include_retired: true })).text)).toBe(3)
  })

  it('requires exact fields and a guarded version for replacement', async () => {
    const { root, call } = await setup()
    const body = document()
    expect((await call({ target: 'topic', action: 'add', topic: '../escape', content: body })).error).toBe(true)
    expect((await call({ target: 'topic', action: 'add', topic: 'door', content: '## Rule\nNo frontmatter' })).text).toContain('frontmatter')
    expect((await call({ target: 'topic', action: 'add', topic: 'door', content: body, old_text: 'x' })).text).toContain('unsupported fields')
    expect((await call({ target: 'topic', action: 'add', topic: 'door', content: body })).error).toBe(false)
    const read = versionOf((await call({ target: 'topic', action: 'read', topic: 'door' })).text)
    expect((await call({ target: 'topic', action: 'replace', topic: 'door', content: document('updated') })).text).toContain('expected_version')
    expect((await call({ target: 'topic', action: 'replace', topic: 'door', content: document('updated'), expected_version: 'stale' })).text).toContain('current version')
    expect((await call({ target: 'topic', action: 'replace', topic: 'door', content: document('updated'), expected_version: read })).error).toBe(false)
    expect(await readFile(join(root, 'memories', 'door.md'), 'utf8')).toBe(document('updated'))
  })

  it('bounds topic files and refuses symlinked files and directories', async () => {
    const { root, call } = await setup({ topicMaxChars: 200, topicReadMaxChars: 200, topicMaxFiles: 1 })
    const body = document()
    expect(body.length).toBeLessThan(200)
    expect((await call({ target: 'topic', action: 'add', topic: 'door', content: body })).error).toBe(false)
    expect((await call({ target: 'topic', action: 'add', topic: 'other', content: body })).text).toContain('full at 1 files')
    expect((await call({ target: 'topic', action: 'read', topic: 'door', include_retired: true })).text).toContain('unsupported fields')
    await rm(join(root, 'memories', 'door.md'))
    await symlink(join(root, 'missing.md'), join(root, 'memories', 'door.md'))
    expect((await call({ target: 'topic', action: 'read', topic: 'door' })).text).toContain('symbolic link')
    await rm(join(root, 'memories', 'door.md'))
    await rm(join(root, 'memories'), { recursive: true })
    await symlink(root, join(root, 'memories'))
    expect((await call({ target: 'topic', action: 'list' })).text).toContain('symbolic link')
  })

  it('counts every Markdown file and rejects invalid filenames during listing', async () => {
    const { root, call } = await setup({ topicMaxFiles: 1 })
    await mkdir(join(root, 'memories'))
    await writeFile(join(root, 'memories', 'Bad_Name.md'), document())
    expect((await call({ target: 'topic', action: 'list' })).text).toContain('invalid slug')
    await writeFile(join(root, 'memories', 'other.md'), document())
    expect((await call({ target: 'topic', action: 'add', topic: 'third', content: document() })).text).toContain('over the 1-file cap')
  })

  it('reports missing, duplicate, and retired topics without changing files', async () => {
    const { root, call } = await setup()
    expect((await call({ target: 'topic', action: 'read', topic: 'door' })).text).toContain('does not exist')
    expect((await call({ target: 'topic', action: 'replace', topic: 'door', content: document(), expected_version: 'stale' })).text).toContain('does not exist')
    expect((await call({ target: 'topic', action: 'remove', topic: 'door', expected_version: 'stale' })).text).toContain('does not exist')
    expect((await call({ target: 'topic', action: 'add', topic: 'door', content: document('retired').replace('status: active', 'status: retired') })).text).toContain('active status')
    expect((await call({ target: 'topic', action: 'add', topic: 'door', content: document() })).error).toBe(false)
    expect((await call({ target: 'topic', action: 'add', topic: 'door', content: document() })).text).toContain('already exists')
    const version = versionOf((await call({ target: 'topic', action: 'read', topic: 'door' })).text)
    expect((await call({ target: 'topic', action: 'remove', topic: 'door', expected_version: version })).error).toBe(false)
    const retiredVersion = versionOf((await call({ target: 'topic', action: 'read', topic: 'door' })).text)
    expect((await call({ target: 'topic', action: 'remove', topic: 'door', expected_version: retiredVersion })).text).toContain('already retired')
    expect(await readFile(join(root, 'memories', 'door.md'), 'utf8')).toContain('status: retired')
    await writeFile(join(root, 'memories', 'other.md'), document().replace('superseded-by: \n', ''))
    const otherVersion = versionOf((await call({ target: 'topic', action: 'read', topic: 'other' })).text)
    expect((await call({ target: 'topic', action: 'remove', topic: 'other', expected_version: otherVersion, superseded_by: 'door' })).error).toBe(false)
    expect(await readFile(join(root, 'memories', 'other.md'), 'utf8')).toContain('superseded-by: door')
  })

  it('bounds on-demand reads and write results with the current version and excerpt', async () => {
    const { root, call } = await setup({ topicMaxChars: 200, topicReadMaxChars: 100 })
    expect((await call({ target: 'topic', action: 'add', topic: 'door', content: document() })).error).toBe(false)
    const read = await call({ target: 'topic', action: 'read', topic: 'door' })
    expect(read.text).toContain('read cap')
    expect(read.text).toContain('sha256:')
    expect(read.text).toContain('Use the side door')
    const huge = document('x'.repeat(100))
    expect((await call({ target: 'topic', action: 'add', topic: 'large', content: huge })).text).toContain('version absent')
    const current = await readFile(join(root, 'memories', 'door.md'), 'utf8')
    const version = topicVersion(current)
    const over = await call({ target: 'topic', action: 'replace', topic: 'door', expected_version: version, content: huge })
    expect(over.text).toContain('current excerpt')
    expect(over.text).toContain('Use the side door')
  })

  it('rejects linked, oversized, and malformed files during list and read', async () => {
    const { root, call } = await setup({ topicMaxChars: 200, topicReadMaxChars: 200 })
    await mkdir(join(root, 'memories'))
    await symlink(join(root, 'missing.md'), join(root, 'memories', 'linked.md'))
    expect((await call({ target: 'topic', action: 'list' })).text).toContain('symbolic link')
    await rm(join(root, 'memories', 'linked.md'))
    await writeFile(join(root, 'memories', 'large.md'), 'x'.repeat(801))
    expect((await call({ target: 'topic', action: 'list' })).text).toContain('file cap')
    expect((await call({ target: 'topic', action: 'read', topic: 'large' })).text).toContain('file cap')
    await rm(join(root, 'memories', 'large.md'))
    await writeFile(join(root, 'memories', 'broken.md'), 'not a topic')
    expect((await call({ target: 'topic', action: 'list' })).text).toContain('frontmatter')
  })

  it('rejects an existing document that exceeds the character cap but fits the byte preflight', async () => {
    const { root, call } = await setup({ topicMaxChars: 200, topicReadMaxChars: 200 })
    await mkdir(join(root, 'memories'))
    const body = document()
    await writeFile(join(root, 'memories', 'door.md'), `${body}${'x'.repeat(201 - body.length)}`)
    const listed = await call({ target: 'topic', action: 'list' })
    expect(listed.text).toContain('file cap')
    expect(listed.text).toContain('current excerpt')
    const read = await call({ target: 'topic', action: 'read', topic: 'door' })
    expect(read.text).toContain('file cap')
    expect(read.text).toContain('sha256:')
  })

  it('returns complete current core entries on cap and ambiguity errors', async () => {
    const { call } = await setup({ memoryMaxChars: 50, entryMaxChars: 30 })
    await call({ target: 'memory', action: 'add', content: 'Door opens inward.' })
    await call({ target: 'memory', action: 'add', content: 'Door hinge needs oil.' })
    const full = await call({ target: 'memory', action: 'add', content: 'A very long extra fact.' })
    expect(full.text).toContain('Door opens inward.')
    expect(full.text).toContain('Door hinge needs oil.')
    const ambiguous = await call({ target: 'memory', action: 'remove', old_text: 'Door' })
    expect(ambiguous.text).toContain('Door opens inward.')
    expect(ambiguous.text).toContain('Door hinge needs oil.')
  })

  it('rejects malformed frontmatter and missing sections', () => {
    expect(() => parseTopic(document().replace('status: active', 'status: hidden'))).toThrow('frontmatter')
    expect(() => parseTopic(document().replace('## Why', '## Reason'))).toThrow('## Rule')
    expect(() => parseTopic(document().replace('source: conversation', 'source: conversation\nsource: repeated'))).toThrow('duplicate')
    expect(() => parseTopic(document().replace('source: conversation', 'bad field'))).toThrow('invalid')
    expect(() => parseTopic(document().replace('superseded-by: ', 'superseded-by: ../outside'))).toThrow('slug')
  })

  it('requires topic fields and routes both topic and core writes through approval', async () => {
    const { call } = await setup({ requireApproval: true })
    expect((await call({ target: 'topic', action: 'read' })).text).toContain('requires topic')
    expect((await call({ target: 'topic', action: 'add', topic: 'door' })).text).toContain('requires a complete Markdown')
    expect((await call({ target: 'topic', action: 'add', topic: 'door', content: document() })).error).toBe(false)
    expect((await call({ target: 'user', action: 'add', content: 'User prefers fish.' })).error).toBe(false)
    expect((await call({ target: 'user', action: 'add', content: '  ' })).text).toContain('empty after trimming')
  })

  it('uses the session policy for approved topic writes and agentless calls', async () => {
    const { ctx, call } = await setup({ requireApproval: true, allowApprovedHomeWrites: true }, true)
    expect((await call({ target: 'topic', action: 'add', topic: 'door', content: document() })).error).toBe(false)
    expect((await call({ target: 'topic', action: 'replace', topic: 'door', content: document('updated'), expected_version: topicVersion(document()) })).error).toBe(false)
    const plain = await setup({}, true)
    const result = await plain.ctx.tools.execute({
      signal: new AbortController().signal, callId: ToolCallId('agentless-core'),
      name: 'memory', arguments: { target: 'user', action: 'add', content: 'User prefers fish.' },
    })
    expect(result.isError).toBe(false)
    const topic = await plain.ctx.tools.execute({
      signal: new AbortController().signal, callId: ToolCallId('agentless-topic'),
      name: 'memory', arguments: { target: 'topic', action: 'add', topic: 'agentless', content: document() },
    })
    expect(topic.isError).toBe(false)
    expect(ctx.sandboxPolicy.resolve().mode).toBe('workspace-write')
  })

  it('refuses a topic directory or target that resolves outside the home', async () => {
    const first = await setup()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-topic-outside-'))
    roots.push(outside)
    const original = first.ctx.fs.resolve.bind(first.ctx.fs)
    vi.spyOn(first.ctx.fs, 'resolve').mockImplementation((path, options) => original(
      path === join(first.root, 'memories') ? outside : path, options,
    ))
    expect((await first.call({ target: 'topic', action: 'list' })).text).toContain('escaped the Harness home')

    const second = await setup()
    const resolveSecond = second.ctx.fs.resolve.bind(second.ctx.fs)
    vi.spyOn(second.ctx.fs, 'resolve').mockImplementation((path, options) => resolveSecond(
      path === join(second.root, 'memories', 'door.md') ? join(outside, 'door.md') : path, options,
    ))
    expect((await second.call({ target: 'topic', action: 'add', topic: 'door', content: document() })).text).toContain('escaped the memories directory')
  })

  it('reports a topic that disappears between listing and stat', async () => {
    const { ctx, root, call } = await setup()
    await mkdir(join(root, 'memories'))
    await writeFile(join(root, 'memories', 'door.md'), document())
    const original = ctx.fs.stat.bind(ctx.fs)
    const disappearing = vi.spyOn(ctx.fs, 'stat').mockImplementation((target, signal) => target.displayPath.endsWith('/door.md')
      ? Promise.resolve(undefined) : original(target, signal))
    expect((await call({ target: 'topic', action: 'list' })).error).toBe(true)
    disappearing.mockRestore()
    const info = await ctx.fs.stat(await ctx.fs.resolve(join(root, 'memories', 'door.md')))
    if (info === undefined) throw new Error('expected topic file')
    const { size: _size, ...withoutSize } = info
    vi.spyOn(ctx.fs, 'stat').mockImplementation((target, signal) => target.displayPath.endsWith('/door.md')
      ? Promise.resolve(withoutSize) : original(target, signal))
    expect((await call({ target: 'topic', action: 'list' })).text).toContain('file cap')
  })
})
