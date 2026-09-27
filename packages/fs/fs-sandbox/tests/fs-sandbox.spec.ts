/**
 * Tests for the sandbox-enforcing filesystem backend: the per-call policy fence
 * on write/edit (read-only denies, workspace-write contains, danger-full-access
 * passes through), reads always passing through, the capability fact, and the
 * containment matrix — `..` traversal, absolute paths outside, and symlink
 * escapes (a symlinked directory inside the workspace pointing out, and a new
 * file created under one). The fence is exercised on a real filesystem: a
 * denied write leaves no file on disk.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, parse, relative, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FsError, FsTargetKey } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { writableRoots, type SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { assertWorkspaceOutsideTemp, outsideTempWorkspaceParent } from '../../../../scripts/snapshot-workspace-parent.ts'

let base: string
let workspace: string
let outside: string
let ctx: Context
let fs: SandboxedFileSystem
let fiber: Awaited<ReturnType<Context['plugin']>>

async function boot(mode: SandboxMode): Promise<void> {
  ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: workspace })
  fiber = await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
  fs = ctx.fs as SandboxedFileSystem
}

beforeEach(async ({ onTestFinished }) => {
  // Both siblings must be outside automatic temp grants for containment denials to be meaningful.
  const directory = await mkdtemp(join(outsideTempWorkspaceParent(), '.dsh-fssbx-'))
  onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  base = directory
  assertWorkspaceOutsideTemp(base)
  workspace = join(base, 'ws')
  outside = join(base, 'out')
  await mkdir(workspace)
  await mkdir(outside)
})
afterEach(async () => {
  await fiber?.dispose()
})

/** Resolve a path through the backend and return its target. */
function target(path: string): Promise<FsTarget> {
  return fs.resolve(path)
}

describe('the capability fact', () => {
  it('reports the deployment default mode (what the tool layer advertises against)', async () => {
    await boot('workspace-write')
    expect(fs.sandboxMode).toBe('workspace-write')
  })
})

describe('read-only', () => {
  beforeEach(() => boot('read-only'))

  it('cannot issue an approved home mutation in read-only mode', () => {
    expect(() => ctx.sandboxPolicy.approveFsMutation(ctx.sandboxPolicy.resolve(), outside, join(outside, 'USER.md')))
      .toThrow('workspace-write')
  })

  it('denies write, leaving no file on disk', async () => {
    const path = join(workspace, 'denied.txt')
    await expect(fs.writeText(await target(path), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(path)).toBe(false)
  })

  it('denies edit of an existing file (the content is unchanged)', async () => {
    const path = join(workspace, 'file.txt')
    await writeFile(path, 'original')
    await expect(fs.editText(await target(path), { oldString: 'original', newString: 'changed', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(path, 'utf8')).toBe('original')
  })

  it('allows reads (every mode permits reading)', async () => {
    const path = join(workspace, 'readable.txt')
    await writeFile(path, 'hello')
    expect(await fs.readText(await target(path))).toBe('hello')
  })
})

describe('workspace-write containment', () => {
  beforeEach(() => boot('workspace-write'))

  it('accepts one approved exact home file and refuses reuse or neighboring files', async () => {
    const path = join(outside, 'MEMORY.md')
    const policy = ctx.sandboxPolicy.resolve()
    const allowance = ctx.sandboxPolicy.approveFsMutation(policy, outside, path)
    expect(Object.isFrozen(allowance)).toBe(true)
    await expect(fs.writeText(await target(join(outside, 'OTHER.md')), 'no', undefined, undefined, policy, allowance))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await fs.writeText(await target(path), 'one', undefined, undefined, policy, allowance)
    expect(await readFile(path, 'utf8')).toBe('one')
    await expect(fs.writeText(await target(path), 'two', undefined, undefined, policy, allowance))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(path, 'utf8')).toBe('one')
  })

  it('refuses to issue an allowance for a target outside the configured home', () => {
    const policy = ctx.sandboxPolicy.resolve()
    expect(() => ctx.sandboxPolicy.approveFsMutation(policy, outside, join(workspace, 'USER.md')))
      .toThrow('inside the configured Harness home')
  })

  it('refuses a forged allowance and a symlinked home ancestor', async () => {
    const path = join(outside, 'MEMORY.md')
    const policy = ctx.sandboxPolicy.resolve()
    await expect(fs.writeText(await target(path), 'no', undefined, undefined, policy,
      { homePath: outside, targetPath: path })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    const link = join(outside, 'link')
    const actual = join(base, 'actual')
    await mkdir(actual)
    await symlink(actual, link)
    const linkedPath = join(link, 'MEMORY.md')
    const allowance = ctx.sandboxPolicy.approveFsMutation(policy, outside, linkedPath)
    await expect(fs.writeText(await target(linkedPath), 'no', undefined, undefined, policy, allowance))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(join(actual, 'MEMORY.md'))).toBe(false)
  })

  it('keeps the approved file outside the shared writable roots', async () => {
    const path = join(outside, 'USER.md')
    const policy = ctx.sandboxPolicy.resolve()
    const allowance = ctx.sandboxPolicy.approveFsMutation(policy, outside, path)
    await fs.writeText(await target(path), 'approved', undefined, undefined, policy, allowance)
    expect(writableRoots(policy).every((root) => {
      const suffix = relative(root, path)
      return suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)
    })).toBe(true)
    await expect(fs.writeText(await target(join(outside, 'shell.txt')), 'blocked', undefined, undefined, policy))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('creates only the approved home directory and removes a versioned approved file', async () => {
    const policy = ctx.sandboxPolicy.resolve()
    const directory = join(outside, 'memories')
    await fs.makeDirectory(await target(directory), undefined, policy,
      ctx.sandboxPolicy.approveFsMutation(policy, outside, directory))
    const path = join(directory, 'doors.md')
    await fs.writeText(await target(path), 'topic', undefined, undefined, policy,
      ctx.sandboxPolicy.approveFsMutation(policy, outside, path))
    const resolved = await target(path)
    const version = (await fs.stat(resolved))?.version
    if (version === undefined) throw new Error('expected saved file version')
    await fs.removeFile(resolved, undefined, policy,
      ctx.sandboxPolicy.approveFsMutation(policy, outside, path), version)
    expect(existsSync(path)).toBe(false)
    await expect(fs.makeDirectory(await target(join(outside, 'other')), undefined, policy))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('does not create a missing home or intermediate ancestor through an exact-target ticket', async () => {
    const policy = ctx.sandboxPolicy.resolve()
    const missingHome = join(outside, 'missing-home')
    const missingHomeTarget = join(missingHome, 'memories')
    await expect(fs.makeDirectory(await target(missingHomeTarget), undefined, policy,
      ctx.sandboxPolicy.approveFsMutation(policy, missingHome, missingHomeTarget)))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(missingHome)).toBe(false)

    const nested = join(outside, 'missing-parent', 'USER.md')
    await expect(fs.writeText(await target(nested), 'blocked', undefined, undefined, policy,
      ctx.sandboxPolicy.approveFsMutation(policy, outside, nested)))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(join(outside, 'missing-parent'))).toBe(false)
  })

  it('rejects a symlinked ancestor even when it points inside the approved home', async () => {
    const actual = join(outside, 'actual')
    await mkdir(actual)
    const link = join(outside, 'link')
    await symlink(actual, link)
    const path = join(link, 'USER.md')
    const policy = ctx.sandboxPolicy.resolve()
    await expect(fs.writeText(await target(path), 'blocked', undefined, undefined, policy,
      ctx.sandboxPolicy.approveFsMutation(policy, outside, path)))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(join(actual, 'USER.md'))).toBe(false)
  })

  it('a write under the workspace lands', async () => {
    const path = join(workspace, 'nested', 'ok.txt')
    const outcome = await fs.writeText(await target(path), 'inside')
    expect(outcome.operation).toBe('create')
    expect(await readFile(path, 'utf8')).toBe('inside')
  })

  it('a write to the platform temp area lands (parity with the bash runner grant)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-fssbx-tmp-'))
    try {
      const path = join(dir, 'temp.txt')
      await fs.writeText(await target(path), 'temp')
      expect(await readFile(path, 'utf8')).toBe('temp')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('an absolute path outside the workspace is denied, no file created', async () => {
    const path = join(outside, 'escape.txt')
    await expect(fs.writeText(await target(path), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(path)).toBe(false)
  })

  it('a `..` traversal out of the workspace is denied', async () => {
    const path = join(workspace, '..', 'sibling-escape.txt')
    await expect(fs.writeText(await target(path), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(join(workspace, '..', 'sibling-escape.txt'))).toBe(false)
  })

  it('a symlinked directory inside the workspace pointing OUT is denied (canonicalized before containment)', async () => {
    // workspace/link -> outside ; writing workspace/link/f.txt would land in outside/f.txt.
    await symlink(outside, join(workspace, 'link'))
    const path = join(workspace, 'link', 'f.txt')
    await expect(fs.writeText(await target(path), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(join(outside, 'f.txt'))).toBe(false)
  })

  it('a NEW file created under a symlinked-out directory is denied (deepest-ancestor realpath)', async () => {
    await symlink(outside, join(workspace, 'link'))
    const path = join(workspace, 'link', 'newdir', 'deep.txt')
    await expect(fs.writeText(await target(path), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(join(outside, 'newdir'))).toBe(false)
  })

  it('an edit outside the workspace is denied; the original is untouched', async () => {
    const path = join(outside, 'file.txt')
    await writeFile(path, 'original')
    await expect(fs.editText(await target(path), { oldString: 'original', newString: 'x', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(path, 'utf8')).toBe('original')
  })

  it('an edit inside the workspace lands', async () => {
    const path = join(workspace, 'edit.txt')
    await writeFile(path, 'original')
    const outcome = await fs.editText(await target(path), { oldString: 'original', newString: 'changed', replaceAll: false })
    expect(outcome.after).toBe('changed')
    expect(await readFile(path, 'utf8')).toBe('changed')
  })

  it('mutates the freshly checked identity, not a stale outside targetKey (TOCTOU direction)', async () => {
    // A target whose displayPath is inside the workspace but whose targetKey is
    // a STALE outside path — as if an ancestor symlink pointed out at the tool's
    // resolve() and was swapped in before the write. The fence re-resolves
    // displayPath (now inside) AND delegates with that fresh target, so the byte
    // lands inside and the stale outside path is never written.
    const insidePath = join(workspace, 'landed.txt')
    const staleTarget: FsTarget = { displayPath: insidePath, targetKey: FsTargetKey(join(outside, 'escaped.txt')) }
    await fs.writeText(staleTarget, 'inside')
    expect(await readFile(insidePath, 'utf8')).toBe('inside')
    expect(existsSync(join(outside, 'escaped.txt'))).toBe(false)
  })

  it('the workspace root itself passes the fence (path equal to a writable root), failing only on file type', async () => {
    // isUnder's path-equals-root branch: the fence allows the root, and the
    // write then fails because the root is a directory, not a regular file.
    await expect(fs.writeText(await target(workspace), 'x')).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
  })
})

describe('workspace-write with the filesystem root as the workspace (a root ending in the path separator)', () => {
  it('grants writes anywhere on that volume', async () => {
    // A degenerate but valid config: the filesystem root containing the target.
    // It exercises the separator-suffixed-root branch on POSIX and Windows.
    const rootCtx = new Context()
    await rootCtx.plugin(SessionProjectionRegistry)
    await rootCtx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: parse(base).root })
    const rootFiber = await rootCtx.plugin(SandboxedFileSystem, { cwd: workspace })
    const rootFs = rootCtx.fs as SandboxedFileSystem
    try {
      const path = join(base, 'anywhere.txt') // outside temp — allowed only via the filesystem root
      await rootFs.writeText(await rootFs.resolve(path), 'anywhere')
      expect(await readFile(path, 'utf8')).toBe('anywhere')
    } finally {
      await rootFiber.dispose()
    }
  })
})

describe('danger-full-access', () => {
  beforeEach(() => boot('danger-full-access'))

  it('writes anywhere, unfenced', async () => {
    const path = join(outside, 'free.txt')
    await fs.writeText(await target(path), 'free')
    expect(await readFile(path, 'utf8')).toBe('free')
  })
})

describe('the per-call policy override (escalation)', () => {
  it('a workspace-write stamp on a read-only default lets a contained write land for that call only', async () => {
    await boot('read-only')
    const path = join(workspace, 'escalated.txt')
    // Default read-only would deny; the per-call workspace-write policy allows it (contained).
    await fs.writeText(await target(path), 'granted', undefined, undefined, { mode: 'workspace-write', workspaceRoot: workspace })
    expect(await readFile(path, 'utf8')).toBe('granted')
    // A neighboring plain call still runs under the read-only default.
    await expect(fs.writeText(await target(join(workspace, 'plain.txt')), 'x'))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('a danger-full-access stamp bypasses the fence for that call', async () => {
    await boot('read-only')
    const path = join(outside, 'granted-full.txt')
    await fs.writeText(await target(path), 'full', undefined, undefined, { mode: 'danger-full-access', workspaceRoot: workspace })
    expect(await readFile(path, 'utf8')).toBe('full')
  })
})

describe('registration and HMR safety', () => {
  it('registers as ctx.fs and unregisters cleanly from a child fiber', async () => {
    await boot('workspace-write')
    expect(ctx.fs).toBeInstanceOf(SandboxedFileSystem)
    await fiber.dispose()
    expect(ctx.get('fs')).toBeUndefined()
    // Re-mount below the disposed one to prove no lingering registration.
    fiber = await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
    expect(ctx.fs).toBeInstanceOf(SandboxedFileSystem)
  })
})

describe('FsError identity', () => {
  it('the denial is a structured FsError distinct from a host permission error', async () => {
    await boot('read-only')
    const error = await fs.writeText(await target(join(workspace, 'x.txt')), 'x').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FsError)
    expect((error as FsError).code).toBe('FS_SANDBOX_DENIED')
  })
})
