import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { captureWorkspaceHead, diffShortstat } from '../src/workspace.ts'

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
  it('reads the current HEAD and a clean status', async () => {
    const dir = await initRepo()
    const { head, dirty } = await captureWorkspaceHead(dir)
    expect(head).toMatch(/^[0-9a-f]{40}$/)
    expect(dirty).toBe(false)
  })

  it('reports dirty when the working tree has uncommitted changes', async () => {
    const dir = await initRepo()
    await writeFile(join(dir, 'file.txt'), 'one\ntwo\n', 'utf8')
    const { head, dirty } = await captureWorkspaceHead(dir)
    expect(head).toMatch(/^[0-9a-f]{40}$/)
    expect(dirty).toBe(true)
  })

  it('returns null head and dirty outside a repository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-training-export-non-repo-'))
    dirs.push(dir)
    const { head, dirty } = await captureWorkspaceHead(dir)
    expect(head).toBeNull()
    expect(dirty).toBeNull()
  })
})

describe('diffShortstat', () => {
  it('parses files/insertions/deletions against a captured head', async () => {
    const dir = await initRepo()
    const { head } = await captureWorkspaceHead(dir)
    await writeFile(join(dir, 'file.txt'), 'one\ntwo\nthree\n', 'utf8')
    const stat = await diffShortstat(dir, head as string)
    expect(stat).toEqual({ files: 1, insertions: 2, deletions: 0 })
  })

  it('reports zero insertions when a diff only deletes lines', async () => {
    const dir = await initRepo()
    await writeFile(join(dir, 'file.txt'), 'one\ntwo\n', 'utf8')
    await execFileAsync('git', ['add', 'file.txt'], { cwd: dir })
    await execFileAsync('git', ['commit', '-q', '-m', 'add a line'], { cwd: dir })
    const { head } = await captureWorkspaceHead(dir)
    await writeFile(join(dir, 'file.txt'), 'one\n', 'utf8')
    const stat = await diffShortstat(dir, head as string)
    expect(stat).toEqual({ files: 1, insertions: 0, deletions: 1 })
  })

  it('returns null when nothing changed since the captured head', async () => {
    const dir = await initRepo()
    const { head } = await captureWorkspaceHead(dir)
    const stat = await diffShortstat(dir, head as string)
    expect(stat).toBeNull()
  })

  it('returns null outside a repository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-training-export-non-repo-'))
    dirs.push(dir)
    const stat = await diffShortstat(dir, 'HEAD')
    expect(stat).toBeNull()
  })
})
