/**
 * Sandbox-policy threading: `skill_manage` writes must carry the CALLING
 * session's policy, the way `write`/`edit` do. Omitting it made the confining
 * filesystem fall back to the deployment default (its mode plus its fallback
 * workspace root), so a skill inside the session's own workspace was refused,
 * and a user-scope skill in the Harness home could never be written by a
 * session that legitimately holds full access.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import * as toolSkill from '@deepseek-ai/dsh-tool-skill'

type Mode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** Outside both `/tmp` and `os.tmpdir()`: those are writable roots, so a confinement test built there proves nothing. */
const SCRATCH = '/var/tmp'

const testSignal = new AbortController().signal
const tempDirs: string[] = []
const savedDshHome = process.env.DSH_HOME

afterEach(async () => {
  if (savedDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedDshHome
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(SCRATCH, `dsh-${name}-`))
  tempDirs.push(dir)
  return dir
}

/** An Agent whose session carries an immutable cwd; the policy resolves its root from it. */
function agentForCwd(cwd: string, modeOverride?: Mode): Agent {
  const id = SessionId(`policy-${cwd}`)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd, isSeeded: false,
  })
  // A logged override is how a live session raises its mode; the policy service folds it
  // in through the `sandboxMode` projection.
  if (modeOverride !== undefined) session.append('sandbox/mode', { mode: modeOverride })
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

/**
 * Mount the tool over a CONFINING filesystem. The policy service's fallback root and the
 * session cwd are deliberately different directories, so a call that fails to thread the
 * session policy is refused while one that threads it succeeds.
 */
async function setup(mode: Mode): Promise<{ ctx: Context; workspace: string; home: string }> {
  const workspace = await tempDir('policy-ws')
  await mkdir(join(workspace, '.git'), { recursive: true })
  const fallback = await tempDir('policy-fallback')
  const home = await tempDir('policy-home')
  process.env.DSH_HOME = join(home, '.dsh')
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SkillRegistry)
  // SandboxPolicyService declares sessionProjections as a required injection.
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: fallback })
  await ctx.plugin(SandboxedFileSystem, { cwd: fallback })
  await ctx.plugin(toolSkill, { enableSkillManagement: true, enableUserSkillManagement: true })
  return { ctx, workspace, home }
}

async function call(ctx: Context, args: Record<string, unknown>, agent?: Agent): Promise<{ isError: boolean; text: string }> {
  const result = await ctx.tools.execute({
    signal: testSignal,
    callId: ToolCallId(`policy-${Math.random().toString(36).slice(2)}`),
    name: 'skill_manage',
    arguments: args,
    ...(agent === undefined ? {} : { agent }),
  })
  const first = result.content[0]
  return { isError: result.isError, text: first?.type === 'text' ? first.text : '' }
}

describe('skill_manage sandbox policy threading', () => {
  it('writes a workspace skill under the session cwd, not the deployment fallback root', async () => {
    const { ctx, workspace } = await setup('workspace-write')
    const result = await call(ctx, {
      action: 'create', name: 'threaded', description: 'd', content: '# Body',
    }, agentForCwd(workspace))

    expect(result.text).toContain('created skill threaded')
    // The file landed in the session's workspace; the fallback root stayed empty.
    await expect(readFile(join(workspace, '.agents', 'skills', 'threaded.md'), 'utf8')).resolves.toContain('name: "threaded"')
  })

  it('writes a user-scope skill into the Harness home for a full-access session', async () => {
    const { ctx, workspace, home } = await setup('danger-full-access')
    const result = await call(ctx, {
      action: 'create', name: 'everywhere', description: 'd', content: '# Body', scope: 'user',
    }, agentForCwd(workspace))

    expect(result.text).toContain('created skill everywhere')
    await expect(readFile(join(home, '.dsh', 'skills', 'everywhere.md'), 'utf8')).resolves.toContain('name: "everywhere"')
  })

  it('writes a user-scope skill when only the SESSION raised itself to full access', async () => {
    // The live shape this bug was reported from: the deployment stays confined and a
    // session holds an override. Without threading, resolve() sees no session and falls
    // back to the deployment default, refusing the Harness home.
    const { ctx, workspace, home } = await setup('workspace-write')
    const result = await call(ctx, {
      action: 'create', name: 'raised', description: 'd', content: '# Body', scope: 'user',
    }, agentForCwd(workspace, 'danger-full-access'))

    expect(result.text).toContain('created skill raised')
    await expect(readFile(join(home, '.dsh', 'skills', 'raised.md'), 'utf8')).resolves.toContain('name: "raised"')
  })

  it('still refuses a user-scope skill when the session is confined to its workspace', async () => {
    const { ctx, workspace } = await setup('workspace-write')
    const result = await call(ctx, {
      action: 'create', name: 'locked', description: 'd', content: '# Body', scope: 'user',
    }, agentForCwd(workspace))

    expect(result.isError).toBe(true)
    expect(result.text).toContain('workspace-write')
  })
})
