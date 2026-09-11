/**
 * Sandbox-policy threading for the memory store. `MEMORY.md`/`USER.md` live in the Harness
 * home, outside every session workspace, so the tool must write them under the CALLING
 * session's policy (its mode plus its cwd as the boundary) rather than the deployment
 * fallback — which refused the tool's own store even for a session holding full access.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import * as toolMemory from '../src/index.ts'

type Mode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** Outside both `/tmp` and `os.tmpdir()`: those are writable roots, so a confinement test built there proves nothing. */
const SCRATCH = '/var/tmp'

const testSignal = new AbortController().signal
const tempDirs: string[] = []

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(SCRATCH, `dsh-${name}-`))
  tempDirs.push(dir)
  return dir
}

/** An Agent whose session carries an immutable cwd and, optionally, a logged mode override. */
function agentForCwd(cwd: string, modeOverride?: Mode): Agent {
  const sessionId = SessionId(`memory-policy-${cwd}`)
  const session = Session.create(sessionId, [], {
    version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 0, cwd, isSeeded: false,
  })
  // A logged override is how a live session raises its mode; the policy service folds it
  // in through the `sandboxMode` projection.
  if (modeOverride !== undefined) session.append('sandbox/mode', { mode: modeOverride })
  return {
    id: sessionId,
    options: {},
    session,
    inbox: unsupportedInbox(),
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

/**
 * Mount the tool over a CONFINING filesystem whose fallback root is neither the memory home
 * nor (by default) the session cwd, so only a policy carrying the right session and mode
 * can let a write through.
 */
async function setup(mode: Mode, options: { cwd?: string; home?: string } = {}): Promise<{
  ctx: Context
  home: string
  cwd: string
}> {
  const home = options.home ?? await tempDir('memory-policy-home')
  const cwd = options.cwd ?? await tempDir('memory-policy-cwd')
  const fallback = await tempDir('memory-policy-fallback')
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  // SandboxPolicyService declares sessionProjections as a required injection.
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: fallback })
  await ctx.plugin(SandboxedFileSystem, { cwd: fallback })
  await ctx.plugin(toolMemory, { dshHome: home })
  return { ctx, home, cwd }
}

async function call(ctx: Context, args: Record<string, unknown>, agent?: Agent): Promise<{ isError: boolean; text: string }> {
  const result = await ctx.tools.execute({
    signal: testSignal,
    callId: ToolCallId(`memory-policy-${Math.random().toString(36).slice(2)}`),
    name: 'memory',
    arguments: args,
    ...(agent === undefined ? {} : { agent }),
  })
  const first = result.content[0]
  return { isError: result.isError, text: first?.type === 'text' ? first.text : '' }
}

describe('memory sandbox policy threading', () => {
  it('writes the store when the deployment grants full access', async () => {
    const { ctx, home, cwd } = await setup('danger-full-access')
    const result = await call(ctx, { target: 'user', action: 'add', content: 'User runs fish shell.' }, agentForCwd(cwd))

    expect(result.isError).toBe(false)
    await expect(readFile(join(home, 'USER.md'), 'utf8')).resolves.toContain('User runs fish shell.')
  })

  it('writes the store when only the SESSION raised itself to full access', async () => {
    // The live shape this bug was reported from: a confined deployment plus a session
    // override. Unthreaded, resolve() sees no session and applies the deployment default.
    const { ctx, home, cwd } = await setup('workspace-write')
    const result = await call(ctx,
      { target: 'user', action: 'add', content: 'Gateway runs as a systemd user unit.' },
      agentForCwd(cwd, 'danger-full-access'))

    expect(result.isError).toBe(false)
    await expect(readFile(join(home, 'USER.md'), 'utf8')).resolves.toContain('systemd user unit')
  })

  it('takes the workspace boundary from the session, not the deployment fallback root', async () => {
    // Confined mode whose session cwd IS the memory home: threading resolves the root to
    // the home and allows the write; the unthreaded fallback root would deny it.
    const home = await tempDir('memory-policy-home-as-cwd')
    const { ctx } = await setup('workspace-write', { home, cwd: home })
    const result = await call(ctx,
      { target: 'memory', action: 'add', content: 'Pi-hole answers DHCP.' },
      agentForCwd(home))

    expect(result.isError).toBe(false)
    await expect(readFile(join(home, 'MEMORY.md'), 'utf8')).resolves.toContain('Pi-hole')
  })

  it('still refuses the store when the session stays confined elsewhere', async () => {
    const { ctx, cwd } = await setup('workspace-write')
    const result = await call(ctx, { target: 'memory', action: 'add', content: 'Nope.' }, agentForCwd(cwd))

    expect(result.isError).toBe(true)
    expect(result.text).toContain('workspace-write')
  })
})
