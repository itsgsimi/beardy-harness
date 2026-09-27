/** Git and temporary-index failures stay local to one workspace capture. */

type GitResult = { stdout: string; stderr: string }
type ExecFileAsyncMock = (
  command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv },
) => Promise<GitResult>

const { execFileAsyncMock, rmMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn<ExecFileAsyncMock>(),
  rmMock: vi.fn<typeof import('node:fs/promises').rm>(),
}))

vi.mock('node:util', async original => ({
  ...await original<typeof import('node:util')>(),
  promisify: () => execFileAsyncMock,
}))
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), rm: rmMock }))

import { beforeEach, expect, it, vi } from 'vitest'
import { captureWorkspaceHead, diffTreeSnapshot } from '../src/workspace.ts'

const tree = 'a'.repeat(40)
const failures = new Set<string>()
const output = new Map<string, string>()

beforeEach(() => {
  failures.clear()
  output.clear()
  execFileAsyncMock.mockReset()
  rmMock.mockReset()
  rmMock.mockResolvedValue()
  execFileAsyncMock.mockImplementation(async (_command, args) => {
    const command = args[0] ?? ''
    if (failures.has(command)) throw new Error(`git ${command} failed`)
    return { stdout: output.get(command) ?? (command === 'write-tree' ? `${tree}\n` : ''), stderr: '' }
  })
  output.set('rev-parse', 'b'.repeat(40) + '\n')
})

it('retains HEAD when status fails and reports a missing tree when add fails', async () => {
  failures.add('status')
  failures.add('add')
  const result = await captureWorkspaceHead('/fixture')
  expect(result).toEqual({ head: 'b'.repeat(40), dirty: null, tree: null })
  expect(rmMock).toHaveBeenCalledOnce()
})

it('drops a failed write-tree and contains temporary-index cleanup failure', async () => {
  failures.add('write-tree')
  expect(await captureWorkspaceHead('/fixture')).toMatchObject({ tree: null })
  failures.delete('write-tree')
  rmMock.mockRejectedValueOnce(new Error('temporary index already gone'))
  expect(await captureWorkspaceHead('/fixture')).toMatchObject({ tree })
})

it('reports a failed ending snapshot or diff and parses deletion-only changes', async () => {
  failures.add('add')
  expect(await diffTreeSnapshot('/fixture', tree)).toBeNull()
  failures.delete('add')
  failures.add('diff')
  expect(await diffTreeSnapshot('/fixture', tree)).toBeNull()
  failures.delete('diff')
  output.set('diff', ' 1 file changed, 2 deletions(-)\n')
  expect(await diffTreeSnapshot('/fixture', tree)).toEqual({ files: 1, insertions: 0, deletions: 2 })
})
