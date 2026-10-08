import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import * as toolSkillManage from '@deepseek-ai/dsh-tool-skill-manage'

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
    const id = SessionId('manage-no-cwd')
    const session = Session.create(id, [], {
      version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false,
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
async function setup(config: toolSkillManage.Config, withPolicy = false): Promise<{ ctx: Context; workspace: string; home: string }> {
  const workspace = await tempDir('manage-scope-ws')
  await mkdir(join(workspace, '.git'), { recursive: true })
  const home = await tempDir('manage-scope-home')
  process.env.DSH_HOME = join(home, '.dsh')
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SkillRegistry)
  if (withPolicy) {
    await ctx.plugin(SessionProjections)
    await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: workspace })
  }
  await ctx.plugin(LocalFileSystem, { cwd: workspace })
  await ctx.plugin(SkillFileSystem, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), watch: false })
  await ctx.plugin(toolSkillManage, config)
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
  it('checks frontmatter, routing, length, and catalog overlap without writing or asking approval', async () => {
    const { ctx, workspace } = await setup({ enableSkillManagement: true, requireApproval: true, skillBodyMaxBytes: 16 })
    ctx.skills.register({ name: 'existing-skill', description: 'Use when the weekly review is due.', source: 'runtime', content: 'Steps.' })
    const result = await call(ctx, { action: 'check', name: 'new-skill', description: 'Use when the weekly review is due.',
      content: '---\nname: fake\n---\n\nLong content.' }, agentForCwd(workspace))
    expect(result.isError).toBe(false)
    const lint = JSON.parse(result.text) as { errors: string[]; warnings: string[]; bytes: number }
    expect(lint.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('frontmatter comes from'), expect.stringContaining('limit is 16 bytes'),
    ]))
    expect(lint.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('whenToUse is missing'), expect.stringContaining('overlaps catalog skill'),
    ]))
    expect(lint.bytes).toBeGreaterThan(16)
    await expect(readFile(join(workspace, '.agents', 'skills', 'new-skill.md'), 'utf8')).rejects.toThrow()
  })

  it('enforces the exact UTF-8 body cap before approval and accepts its boundary', async () => {
    const { ctx, workspace } = await setup({ enableSkillManagement: true, requireApproval: true, skillBodyMaxBytes: 5 })
    let asks = 0
    ctx.provide('approval' as never, { request: async () => { asks += 1; return 'allowed-once' } } as never)
    const agent = agentForCwd(workspace)
    const oversized = await call(ctx, { action: 'create', name: 'byte-cap', description: 'A test skill', content: 'ééé' }, agent)
    expect(oversized.isError).toBe(true)
    expect(oversized.text).toContain('7 bytes; limit is 5 bytes')
    expect(asks).toBe(0)
    expect((await call(ctx, { action: 'check', name: 'byte-cap', description: 'A test skill', content: 'éé' }, agent)).text)
      .toContain('"bytes":5')
    const boundary = await call(ctx, { action: 'create', name: 'byte-cap', description: 'A test skill', content: 'éé' }, agent)
    expect(boundary.isError).toBe(false)
    expect(asks).toBe(1)
    expect(await readFile(join(workspace, '.agents', 'skills', 'byte-cap.md'), 'utf8')).toContain('éé\n')
    const update = await call(ctx, { action: 'update', name: 'byte-cap', description: 'A test skill', content: 'ééé' }, agent)
    expect(update.isError).toBe(true)
    expect(update.text).toContain('7 bytes; limit is 5 bytes')
    expect(asks).toBe(1)
  })

  it('reports missing required fields before requesting approval', async () => {
    const { ctx, workspace } = await setup({ enableSkillManagement: true, requireApproval: true })
    let asks = 0
    ctx.provide('approval' as never, { request: async () => { asks += 1; return 'allowed-once' } } as never)
    const result = await call(ctx, { action: 'update', name: 'invalid-draft', content: 'Body.' }, agentForCwd(workspace))
    expect(result.isError).toBe(true)
    expect(result.text).toContain('description is required')
    expect(asks).toBe(0)
  })

  it('returns hard errors for invalid names and missing or duplicate frontmatter fields', async () => {
    const { ctx, workspace } = await setup({ enableSkillManagement: true })
    const agent = agentForCwd(workspace)
    const invalid = await call(ctx, { action: 'check', name: 'Bad_Name', content: '---\r\nname: bad\r\n---' }, agent)
    expect(invalid.isError).toBe(false)
    expect((JSON.parse(invalid.text) as { errors: string[] }).errors).toEqual(expect.arrayContaining([
      expect.stringContaining('invalid skill name'), expect.stringContaining('description is required'),
      expect.stringContaining('frontmatter comes from'),
    ]))
    const empty = await call(ctx, { action: 'check', name: 'valid-name', description: 'A useful description', content: '   ' }, agent)
    expect((JSON.parse(empty.text) as { errors: string[] }).errors).toContain('content is required for create and update')
    const missing = await call(ctx, { action: 'check', name: 'valid-name', description: 'A useful description' }, agent)
    expect((JSON.parse(missing.text) as { errors: string[] }).errors).toContain('content is required for create and update')
  })

  it('reports routing warnings for a short trigger and an existing catalog name', async () => {
    const { ctx, workspace } = await setup({ enableSkillManagement: true })
    ctx.skills.register({ name: 'weekly-plan', description: 'A catalog skill', source: 'runtime', content: 'Steps.' })
    ctx.skills.register({ name: 'garden-care', description: 'Use when watering garden plants.', source: 'runtime', content: 'Water.' })
    const agent = agentForCwd(workspace)
    const check = await call(ctx, { action: 'check', name: 'weekly-plan', description: 'Plan the week',
      content: 'Collect the tasks and assign owners.', when_to_use: 'weekly' }, agent)
    expect((JSON.parse(check.text) as { warnings: string[] }).warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('whenToUse is short'), expect.stringContaining('catalog already contains'),
    ]))
    const update = await call(ctx, { action: 'check', name: 'weekly-plan', description: 'Plan the week',
      content: 'Collect the tasks and assign owners.', when_to_use: 'Use when planning the coming household week.' }, agent)
    expect((JSON.parse(update.text) as { warnings: string[] }).warnings).not.toEqual(expect.arrayContaining([expect.stringContaining('whenToUse is short')]))
  })

  it('requires approval and both skill-management scopes for approved home writes', async () => {
    await expect(setup({ allowApprovedHomeWrites: true, enableSkillManagement: true, enableUserSkillManagement: true }))
      .rejects.toThrow('requires requireApproval')
    await expect(setup({ allowApprovedHomeWrites: true, requireApproval: true, enableUserSkillManagement: true }))
      .rejects.toThrow('enableSkillManagement')
  })

  it('creates and deletes one approved user skill outside the workspace under workspace-write', async () => {
    await mkdir(join(process.cwd(), '.cache'), { recursive: true })
    const container = await mkdtemp(join(process.cwd(), '.cache', 'dsh-approved-skill-'))
    tempDirs.push(container)
    const workspace = join(container, 'workspace')
    const home = join(container, 'home')
    await mkdir(join(workspace, '.git'), { recursive: true })
    await mkdir(home)
    process.env.DSH_HOME = home
    let outcome: 'allowed-once' | 'rejected' = 'allowed-once'
    const ctx = new Context()
    ctx.provide('approval' as never, { request: async () => outcome } as never)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: workspace })
    await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
    await ctx.plugin(SkillFileSystem, { dshHome: home, agentsHome: join(container, 'agents'), watch: false })
    await ctx.plugin(toolSkillManage, { enableSkillManagement: true, enableUserSkillManagement: true,
      requireApproval: true, allowApprovedHomeWrites: true })
    const liveAgent = agentForCwd(workspace)
    const path = join(home, 'skills', 'weekly-review.md')
    expect((await call(ctx, { action: 'create', name: 'weekly-review', description: 'Review week',
      content: 'Propose next steps.', scope: 'user' }, liveAgent)).isError).toBe(false)
    expect(await readFile(path, 'utf8')).toContain('Propose next steps.')
    outcome = 'rejected'
    expect((await call(ctx, { action: 'update', name: 'weekly-review', description: 'Review week',
      content: 'Unapproved update.', scope: 'user' }, liveAgent)).isError).toBe(true)
    expect(await readFile(path, 'utf8')).not.toContain('Unapproved update.')
    outcome = 'allowed-once'
    expect((await call(ctx, { action: 'delete', name: 'weekly-review', scope: 'user' }, liveAgent)).isError).toBe(false)
    await expect(readFile(path, 'utf8')).rejects.toThrow()
    await ctx.fiber.dispose()
  })

  it('resolves the fallback policy for an agentless user-scope call', async () => {
    const { ctx, home } = await setup({ enableSkillManagement: true, enableUserSkillManagement: true }, true)
    const result = await call(ctx, { action: 'create', name: 'fallback-policy', description: 'Policy',
      content: 'Use the fallback.', scope: 'user' })
    expect(result.isError).toBe(false)
    expect(await readFile(join(home, '.dsh', 'skills', 'fallback-policy.md'), 'utf8')).toContain('Use the fallback.')
  })
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
    expect(result.text).toContain('requires an Agent-backed session')
  })

  it('refuses agentless user-scope approval without creating a directory', async () => {
    const { ctx, home } = await setup({ enableSkillManagement: true, enableUserSkillManagement: true, requireApproval: true })
    const result = await call(ctx, { action: 'create', name: 'orphan-skill', description: 'An orphan draft', content: 'Body.', scope: 'user' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('no Agent-backed session')
    await expect(readFile(join(home, '.dsh', 'skills', 'orphan-skill.md'), 'utf8')).rejects.toThrow()
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
      await ctx.plugin(toolSkillManage, { enableSkillManagement: true, requireApproval: true })
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
        expect(reason.length).toBeLessThan(900)
        expect(reason).toContain('Lint: 0 errors')
        expect(reason).toContain('Diff at character')
      }
    }
  })

  it('shows a bounded changed span and lint summary for an approved update', async () => {
    const { ctx, workspace } = await setup({ enableSkillManagement: true, requireApproval: true })
    const reasons: string[] = []
    ctx.provide('approval' as never, { request: async (req: { reason: string }) => {
      reasons.push(req.reason)
      return 'allowed-once'
    } } as never)
    const agent = agentForCwd(workspace)
    const fields = { name: 'long-draft', description: 'Use when reviewing a large weekly draft.',
      when_to_use: 'Use when the weekly planning draft must be reviewed.' }
    expect((await call(ctx, { action: 'create', ...fields, content: 'A'.repeat(500) }, agent)).isError).toBe(false)
    expect((await call(ctx, { action: 'update', ...fields, content: 'B'.repeat(500) }, agent)).isError).toBe(false)
    expect(reasons).toHaveLength(2)
    expect(reasons[1]).toContain('Lint: 0 errors, 0 warnings; body 501 bytes.')
    expect(reasons[1]).toContain('Diff at character')
    expect(reasons[1]).toContain('chars omitted')
    expect(reasons[1]?.length).toBeLessThan(900)
  })

  it('presents management calls on a generic card', async () => {
    const { ctx } = await setup({ enableSkillManagement: true })
    expect(ctx.tools.get('skill_manage')?.presentCall?.({ action: 'create', name: 'demo' })).toEqual({
      card: 'generic', title: 'create skill demo', kind: 'execute', rawInput: 'demo',
    })
    expect(ctx.tools.get('skill_manage')?.presentCall?.({ action: 'delete', name: 'demo' })).toEqual({
      card: 'generic', title: 'delete skill demo', kind: 'delete', rawInput: 'demo',
    })
    expect(ctx.tools.get('skill_manage')?.presentCall?.({ action: 'check', name: 'demo' })).toEqual({
      card: 'generic', title: 'check skill demo', kind: 'read', rawInput: 'demo',
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
      class EscapingFileSystem extends LocalFileSystem {
        override async makeDirectory(..._args: Parameters<LocalFileSystem['makeDirectory']>): Promise<void> {}

        override resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }) {
          const target = escapes.target !== undefined && path.endsWith('.md')
            ? '/elsewhere/file.md'
            : escapes.root !== undefined && path.endsWith('skills')
              ? '/elsewhere/skills'
              : path
          return super.resolve(target, opts)
        }
      }
      return new EscapingFileSystem(new Context(), { cwd: '/', diffBasisMaxBytes: 10 * 1024 * 1024 })
    }

    async function setupWithFakeFs(fs: FileSystem, config: toolSkillManage.Config): Promise<Context> {
      const ctx = new Context()
      ctx.provide('fs' as never, fs)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(toolSkillManage, config)
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
