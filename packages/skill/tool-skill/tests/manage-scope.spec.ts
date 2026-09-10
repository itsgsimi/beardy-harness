import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import * as toolSkill from '@deepseek-ai/dsh-tool-skill'

const testToolSignal = new AbortController().signal
let callCounter = 0

/** Every temp dir created by this file, removed after each test. */
const tempDirs: string[] = []
const savedDshHome = process.env.DSH_HOME
afterEach(async () => {
  if (savedDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedDshHome
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(name: string): Promise<string> {
  const dir = await import('node:fs/promises').then(fs => fs.mkdtemp(join(tmpdir(), `dsh-${name}-`)))
  tempDirs.push(dir)
  return dir
}

function agentForCwd(cwd?: string): Agent {
  if (cwd === undefined) {
    // Only session.header.cwd is read on the refusal path; a minimal stub keeps it absent.
    return {
      ctx: new Context(),
      id: SessionId('manage-no-cwd'),
      options: {},
      session: { header: {} } as unknown as Session,
      inbox: {} as Inbox,
      status: 'idle',
      send: () => {},
      followup: () => {},
      steer: () => {},
      inject: () => {},
      cancel() {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
  }
  const id = SessionId(`manage-${cwd}`)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd, isSeeded: false,
  })
  return {
    ctx: new Context(),
    id,
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** Boot the plugin stack over a real workspace and a DSH_HOME-pinned Harness home. */
async function setup(config: toolSkill.Config): Promise<{ ctx: Context; workspace: string; home: string }> {
  const workspace = await tempDir('manage-scope-ws')
  await mkdir(join(workspace, '.git'), { recursive: true })
  const home = await tempDir('manage-scope-home')
  process.env.DSH_HOME = join(home, '.dsh')
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: workspace })
  await ctx.plugin(SkillFileSystem, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), watch: false })
  await ctx.plugin(toolSkill, config)
  return { ctx, workspace, home }
}

async function call(
  ctx: Context,
  args: Record<string, unknown>,
  agent?: Agent,
): Promise<{ isError: boolean; text: string }> {
  callCounter += 1
  const result = await ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`manage-scope-${String(callCounter)}`),
    name: 'skill_manage',
    arguments: args,
    ...(agent !== undefined ? { agent } : {}),
  })
  const first = result.content[0]
  return { isError: result.isError, text: first?.type === 'text' ? first.text : '' }
}

describe('skill_manage scopes and approval', () => {
  it('refuses the user scope when user-scope management is disabled', async () => {
    const { ctx, home } = await setup({ enableSkillManagement: true })
    const result = await call(ctx, {
      action: 'create', name: 'weekly-review', description: 'Review week', content: 'Body.', scope: 'user',
    }, agentForCwd('/ws'))
    expect(result.isError).toBe(true)
    expect(result.text).toContain('user-scope skill management is disabled by configuration')
    await expect(readFile(join(home, '.dsh', 'skills', 'weekly-review.md'), 'utf8')).rejects.toThrow()
  })

  it('creates and deletes a user-scope skill under the Harness home, visible everywhere', async () => {
    const { ctx, workspace, home } = await setup({ enableSkillManagement: true, enableUserSkillManagement: true })
    const agent = agentForCwd(workspace)
    const create = await call(ctx, {
      action: 'create', name: 'weekly-review', description: 'Review the week', content: 'Propose merges.', scope: 'user',
    }, agent)
    expect(create.isError).toBe(false)
    const path = join(home, '.dsh', 'skills', 'weekly-review.md')
    expect(await readFile(path, 'utf8')).toContain('Propose merges.')
    expect((await ctx.skills.list({ cwd: workspace })).map(skill => skill.name)).toContain('weekly-review')

    const remove = await call(ctx, { action: 'delete', name: 'weekly-review', scope: 'user' }, agent)
    expect(remove.isError).toBe(false)
    await expect(readFile(path, 'utf8')).rejects.toThrow()
  })

  it('refuses every mutation when approval is required but no answerer is mounted', async () => {
    const { ctx, workspace } = await setup({ enableSkillManagement: true, requireApproval: true })
    const result = await call(ctx, {
      action: 'create', name: 'gated-skill', description: 'Gated', content: 'Body.',
    }, agentForCwd(workspace))
    expect(result.isError).toBe(true)
    expect(result.text).toContain('no approval answerer is mounted')
    await expect(readFile(join(workspace, '.agents', 'skills', 'gated-skill.md'), 'utf8')).rejects.toThrow()
  })

  it('refuses an approved-gated mutation when the call has no Agent to ask about', async () => {
    const { ctx } = await setup({ enableSkillManagement: true, requireApproval: true })
    const result = await call(ctx, { action: 'delete', name: 'anything' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('no Agent-backed session')
  })

  it('writes only when the approval answerer grants allowed-once', async () => {
    for (const outcome of ['allowed-once', 'rejected'] as const) {
      const workspace = await tempDir('manage-approval-ws')
      await mkdir(join(workspace, '.git'), { recursive: true })
      const home = await tempDir('manage-approval-home')
      process.env.DSH_HOME = join(home, '.dsh')
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
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(LocalFileSystem, { cwd: workspace })
      await ctx.plugin(toolSkill, { enableSkillManagement: true, requireApproval: true })
      const padded = outcome === 'allowed-once' ? 'Gated workflow' : `Gated ${'y'.repeat(150)}`
      const result = await call(ctx, {
        action: 'create', name: 'gated-skill', description: padded, content: 'Body.',
      }, agentForCwd(workspace))
      expect(result.isError).toBe(outcome === 'rejected')
      const written = await readFile(join(workspace, '.agents', 'skills', 'gated-skill.md'), 'utf8').catch(() => undefined)
      expect(written !== undefined).toBe(outcome === 'allowed-once')
      expect(reasons).toHaveLength(1)
      if (outcome === 'allowed-once') {
        expect(reasons[0]).toContain('create workspace skill "gated-skill" (Gated workflow)')
      } else {
        const reason = reasons[0] ?? ''
        expect(reason).toContain('(Gated yyy')
        expect(reason).toContain('…)')
        expect(reason.length).toBeLessThan(260)
      }
    }
  })

  it('presents management calls on a generic card', async () => {
    const { ctx } = await setup({ enableSkillManagement: true })
    expect(ctx.tools.get('skill_manage')?.presentCall?.({ action: 'create', name: 'demo' })).toEqual({
      card: 'generic', title: 'create skill demo', kind: 'execute', rawInput: 'demo',
    })
    expect(ctx.tools.get('skill_manage')?.presentCall?.({ action: 'delete', name: 'demo' })).toEqual({
      card: 'generic', title: 'delete skill demo', kind: 'delete', rawInput: 'demo',
    })
  })

  it('writes optional frontmatter flags into the skill document', async () => {
    const { ctx, workspace } = await setup({ enableSkillManagement: true })
    const agent = agentForCwd(workspace)
    const result = await call(ctx, {
      action: 'create', name: 'flagged-skill', description: 'Flagged', content: 'Body.',
      when_to_use: 'On Fridays', model_invocable: false, user_invocable: false,
    }, agent)
    expect(result.isError).toBe(false)
    const text = await readFile(join(workspace, '.agents', 'skills', 'flagged-skill.md'), 'utf8')
    expect(text).toContain('whenToUse: "On Fridays"')
    expect(text).toContain('disable-model-invocation: true')
    expect(text).toContain('user-invocable: false')
  })

  it('refuses workspace management when the call has no Agent at all', async () => {
    const { ctx } = await setup({ enableSkillManagement: true })
    const result = await call(ctx, { action: 'create', name: 'orphan', description: 'd', content: 'c' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('requires an Agent-backed session')
  })

  it('refuses invalid names and missing document fields', async () => {
    const { ctx, workspace } = await setup({ enableSkillManagement: true })
    const agent = agentForCwd(workspace)
    const badName = await call(ctx, { action: 'create', name: 'Bad_Name', description: 'd', content: 'c' }, agent)
    expect(badName.isError).toBe(true)
    expect(badName.text).toContain('invalid skill name')
    const noDescription = await call(ctx, { action: 'create', name: 'ok-name', content: 'c' }, agent)
    expect(noDescription.isError).toBe(true)
    expect(noDescription.text).toContain('description is required')
    const noContent = await call(ctx, { action: 'create', name: 'ok-name', description: 'd' }, agent)
    expect(noContent.isError).toBe(true)
    expect(noContent.text).toContain('content is required')
  })

  it('refuses lifecycle mismatches and non-regular targets', async () => {
    const { ctx, workspace } = await setup({ enableSkillManagement: true })
    const agent = agentForCwd(workspace)
    const root = join(workspace, '.agents', 'skills')
    await mkdir(join(root, 'weird.md'), { recursive: true })

    const deleteMissing = await call(ctx, { action: 'delete', name: 'ghost' }, agent)
    expect(deleteMissing.isError).toBe(true)
    expect(deleteMissing.text).toContain('does not exist in the workspace skill directory')
    const updateMissing = await call(ctx, { action: 'update', name: 'ghost', description: 'd', content: 'c' }, agent)
    expect(updateMissing.isError).toBe(true)
    expect(updateMissing.text).toContain('use create instead')

    const weirdCreate = await call(ctx, { action: 'create', name: 'weird', description: 'd', content: 'c' }, agent)
    expect(weirdCreate.isError).toBe(true)
    expect(weirdCreate.text).toContain('already exists; use update instead')
    for (const action of ['update', 'delete'] as const) {
      const weird = await call(ctx, { action, name: 'weird', description: 'd', content: 'c' }, agent)
      expect(weird.isError).toBe(true)
      expect(weird.text).toContain('is not a regular file')
    }

    await writeFile(join(root, 'real.md'), '---\nname: real\ndescription: d\n---\n\nBody.\n')
    const doubleCreate = await call(ctx, { action: 'create', name: 'real', description: 'd', content: 'c' }, agent)
    expect(doubleCreate.isError).toBe(true)
    expect(doubleCreate.text).toContain('already exists; use update instead')
  })

  it('refuses a skill path that is a symbolic link', async () => {
    const { ctx, workspace } = await setup({ enableSkillManagement: true })
    const agent = agentForCwd(workspace)
    const root = join(workspace, '.agents', 'skills')
    await mkdir(root, { recursive: true })
    const outside = await tempDir('manage-symlink-outside')
    await writeFile(join(outside, 'target.md'), 'outside body\n')
    await symlink(join(outside, 'target.md'), join(root, 'linked.md'))
    const result = await call(ctx, { action: 'update', name: 'linked', description: 'd', content: 'c' }, agent)
    expect(result.isError).toBe(true)
    expect(result.text).toContain('is a symbolic link')
  })

  it('refuses workspace management when the Agent session has no cwd', async () => {
    const { ctx } = await setup({ enableSkillManagement: true })
    const result = await call(ctx, { action: 'create', name: 'nowhere', description: 'd', content: 'c' }, agentForCwd(undefined))
    expect(result.isError).toBe(true)
    expect(result.text).toContain('requires a workspace cwd')
  })

  describe('containment guards', () => {
    /** Resolve with real prefix semantics but relocate the scope root or the skill file. */
    function fakeFs(escapes: { root?: boolean; target?: boolean }): FileSystem {
      const target = (path: string): unknown => ({ displayPath: path })
      return {
        resolve: async (path: string) => target(
          escapes.target !== undefined && path.endsWith('.md')
            ? '/elsewhere/file.md'
            : escapes.root !== undefined && path.endsWith('skills')
              ? '/elsewhere/skills'
              : path,
        ),
        makeDirectory: async () => undefined,
        lstat: async () => undefined,
        stat: async () => undefined,
        contains: (parent: { displayPath: string }, child: { displayPath: string }) =>
          child.displayPath === parent.displayPath || child.displayPath.startsWith(`${parent.displayPath}/`),
        removeFile: async () => undefined,
        writeText: async () => ({ version: 1, operation: 'create' }),
      } as unknown as FileSystem
    }

    async function setupWithFakeFs(fs: FileSystem, config: toolSkill.Config): Promise<Context> {
      const ctx = new Context()
      ctx.provide('fs' as never, fs)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(toolSkill, config)
      return ctx
    }

    it('refuses a workspace skill root outside the workspace', async () => {
      const ctx = await setupWithFakeFs(fakeFs({ root: true }), { enableSkillManagement: true })
      const result = await call(ctx, { action: 'create', name: 'escape', description: 'd', content: 'c' }, agentForCwd('/ws'))
      expect(result.isError).toBe(true)
      expect(result.text).toContain('workspace skill directory escaped the workspace')
    })

    it('refuses a user skill root outside the Harness home', async () => {
      const ctx = await setupWithFakeFs(
        fakeFs({ root: true }),
        { enableSkillManagement: true, enableUserSkillManagement: true },
      )
      const result = await call(ctx, {
        action: 'create', name: 'escape', description: 'd', content: 'c', scope: 'user',
      }, agentForCwd('/ws'))
      expect(result.isError).toBe(true)
      expect(result.text).toContain('user skill directory escaped the Harness home')
    })

    it('refuses a skill file outside its scope root', async () => {
      const ctx = await setupWithFakeFs(fakeFs({ target: true }), { enableSkillManagement: true })
      const result = await call(ctx, { action: 'create', name: 'escape', description: 'd', content: 'c' }, agentForCwd('/ws'))
      expect(result.isError).toBe(true)
      expect(result.text).toContain('skill target escaped the skill directory')
    })
  })
})
