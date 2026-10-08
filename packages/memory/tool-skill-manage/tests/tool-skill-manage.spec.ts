import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
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
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as toolSkillManage from '@deepseek-ai/dsh-tool-skill-manage'

const testToolSignal = new AbortController().signal
const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-${name}-`))
  tempDirs.push(dir)
  return dir
}

function agentForCwd(cwd: string): Agent {
  const id = SessionId(`skill-manage-${cwd}`)
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd, isSeeded: false })
  return {
    ctx: new Context(), id, options: {}, session, inbox: unsupportedInbox(), status: 'idle',
    send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
  }
}

async function baseContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SkillRegistry)
  return ctx
}

async function sectionNames(ctx: Context): Promise<string[]> {
  return (await ctx.systemPrompt.assemble()).sections.map(section => section.name)
}

describe('dsh-tool-skill-manage', () => {
  it('creates, updates, and deletes a workspace skill through skill_manage', async () => {
    const workspace = await tempDir('skill-manage')
    // The filesystem provider scans .agents/skills only below a detected project root.
    await mkdir(join(workspace, '.git'), { recursive: true })
    const home = await tempDir('skill-manage-home')
    const ctx = await baseContext()
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(SkillFileSystem, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), watch: false })
    await ctx.plugin(toolSkillManage, { enableSkillManagement: true })
    const agent = agentForCwd(workspace)
    const run = (callId: string, args: Record<string, unknown>) => ctx.tools.execute({
      signal: testToolSignal, callId: ToolCallId(callId), name: 'skill_manage', arguments: args, agent,
    })

    const create = await run('create', { action: 'create', name: 'release-checklist', description: 'Release checks', content: 'Run the release checks.' })
    expect(create.isError).toBe(false)
    const path = join(workspace, '.agents/skills/release-checklist.md')
    expect(await readFile(path, 'utf8')).toContain('Run the release checks.')
    expect((await ctx.skills.list({ cwd: workspace })).map(skill => skill.name)).toContain('release-checklist')

    const update = await run('update', { action: 'update', name: 'release-checklist', description: 'Updated checks', content: 'Run the updated checks.' })
    expect(update.isError).toBe(false)
    expect(await readFile(path, 'utf8')).toContain('Run the updated checks.')

    const remove = await run('delete', { action: 'delete', name: 'release-checklist' })
    expect(remove.isError).toBe(false)
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await ctx.skills.list({ cwd: workspace })).map(skill => skill.name)).not.toContain('release-checklist')
  })

  it('adds the pruned-skill reload guidance as a system-prompt section when management is enabled', async () => {
    const ctx = await baseContext()
    const fiber = await ctx.plugin(toolSkillManage, { enableSkillManagement: true })
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.find(section => section.name === 'tool:skill-manage')).toEqual({
      name: 'tool:skill-manage',
      text: 'If a previously loaded skill result contains the marker [... tool result middle pruned ...], its steps are incomplete: reload that skill by name before acting on it.',
    })
    expect(ctx.systemPrompt.getSectionOrder('TOOL_GOAL')).toBeGreaterThan(toolSkillManage.SKILL_MANAGE_SECTION_ORDER)
    await fiber.dispose()
    expect(await sectionNames(ctx)).not.toContain('tool:skill-manage')
  })

  it('adds the reload guidance for a nudge-only composition and omits it when both features are off', async () => {
    const nudged = await baseContext()
    await nudged.plugin(SessionProjections)
    await nudged.plugin(toolSkillManage, { nudgeAfterToolCalls: 3 })
    expect(await sectionNames(nudged)).toContain('tool:skill-manage')
    expect(nudged.tools.get('skill_manage')).toBeUndefined()

    const idle = await baseContext()
    await idle.plugin(toolSkillManage)
    expect(await sectionNames(idle)).not.toContain('tool:skill-manage')
  })

  it('validates the nudge threshold and the skill body cap', async () => {
    const ctx = await baseContext()
    await expect(ctx.plugin(toolSkillManage, { skillBodyMaxBytes: 0 })).rejects.toThrow('skillBodyMaxBytes')
    await expect(ctx.plugin(toolSkillManage, { skillBodyMaxBytes: 1.5 })).rejects.toThrow('skillBodyMaxBytes')
    await expect(ctx.plugin(toolSkillManage, { nudgeAfterToolCalls: -1 })).rejects.toThrow('nudgeAfterToolCalls')
  })
})
