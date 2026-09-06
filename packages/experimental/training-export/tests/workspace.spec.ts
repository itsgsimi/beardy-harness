import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { captureWorkspaceHead, diffTreeSnapshot } from '../src/workspace.ts'

const execFileAsync = promisify(execFile)
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-training-export-workspace-'))
  dirs.push(dir)
  await execFileAsync('git', ['init', '-q'], { cwd: dir })
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  await execFileAsync('git', ['config', 'user.name', 'test'], { cwd: dir })
  await writeFile(join(dir, 'file.txt'), 'one\n', 'utf8')
  await execFileAsync('git', ['add', 'file.txt'], { cwd: dir })
  await execFileAsync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir })
  return dir
}

describe('captureWorkspaceHead', () => {
  it('reads the current HEAD, a clean status, and a tree snapshot', async () => {
    const dir = await initRepo()
    const { head, dirty, tree } = await captureWorkspaceHead(dir)
    expect(head).toMatch(/^[0-9a-f]{40}$/)
    expect(dirty).toBe(false)
    expect(tree).toMatch(/^[0-9a-f]{40}$/)
  })

  it('reports dirty when the working tree has uncommitted changes', async () => {
    const dir = await initRepo()
    await writeFile(join(dir, 'file.txt'), 'one\ntwo\n', 'utf8')
    const { head, dirty, tree } = await captureWorkspaceHead(dir)
    expect(head).toMatch(/^[0-9a-f]{40}$/)
    expect(dirty).toBe(true)
    expect(tree).toMatch(/^[0-9a-f]{40}$/)
  })

  it('returns null head, dirty, and tree outside a repository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-training-export-non-repo-'))
    dirs.push(dir)
    const { head, dirty, tree } = await captureWorkspaceHead(dir)
    expect(head).toBeNull()
    expect(dirty).toBeNull()
    expect(tree).toBeNull()
  })

  it('does not modify the repository\'s real index', async () => {
    const dir = await initRepo()
    await writeFile(join(dir, 'untracked.txt'), 'new\n', 'utf8')
    await captureWorkspaceHead(dir)
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: dir })
    expect(stdout).toBe('?? untracked.txt\n')
  })
})

describe('diffTreeSnapshot', () => {
  it('returns null when a pre-existing dirty tree does not change during the turn', async () => {
    const dir = await initRepo()
    await writeFile(join(dir, 'file.txt'), 'one\ntwo\n', 'utf8')
    const { tree } = await captureWorkspaceHead(dir)
    const stat = await diffTreeSnapshot(dir, tree as string)
    expect(stat).toBeNull()
  })

  it('counts a file modified during the turn', async () => {
    const dir = await initRepo()
    const { tree } = await captureWorkspaceHead(dir)
    await writeFile(join(dir, 'file.txt'), 'one\ntwo\nthree\n', 'utf8')
    const stat = await diffTreeSnapshot(dir, tree as string)
    expect(stat).toEqual({ files: 1, insertions: 2, deletions: 0 })
  })

  it('counts an untracked file created during the turn', async () => {
    const dir = await initRepo()
    const { tree } = await captureWorkspaceHead(dir)
    await writeFile(join(dir, 'new.txt'), 'hello\n', 'utf8')
    const stat = await diffTreeSnapshot(dir, tree as string)
    expect(stat).toEqual({ files: 1, insertions: 1, deletions: 0 })
  })

  it('ignores a file matched by .gitignore both before and after', async () => {
    const dir = await initRepo()
    await writeFile(join(dir, '.gitignore'), 'ignored.txt\n', 'utf8')
    await execFileAsync('git', ['add', '.gitignore'], { cwd: dir })
    await execFileAsync('git', ['commit', '-q', '-m', 'ignore'], { cwd: dir })
    await writeFile(join(dir, 'ignored.txt'), 'before\n', 'utf8')
    const { tree } = await captureWorkspaceHead(dir)
    await writeFile(join(dir, 'ignored.txt'), 'after\n', 'utf8')
    const stat = await diffTreeSnapshot(dir, tree as string)
    expect(stat).toBeNull()
  })

  it('returns null outside a repository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-training-export-non-repo-'))
    dirs.push(dir)
    const stat = await diffTreeSnapshot(dir, 'anytree')
    expect(stat).toBeNull()
  })
})
