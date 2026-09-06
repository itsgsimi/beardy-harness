/**
 * Best-effort `git` reads for the spec's `workspace` sample field and
 * `diff` label field. Every call is `execFile` (never a shell), bounded to a
 * 5s timeout, and never throws: any failure (missing `git`, no repository,
 * timeout) reports as `null`.
 * @module @deepseek-ai/dsh-experimental-training-export/workspace
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { TrainingDiffStat } from './types.ts'

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 5_000

/** Run one `git` subcommand; `null` on any failure (non-repo, missing binary, timeout). */
async function runGit(cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd, timeout: GIT_TIMEOUT_MS, encoding: 'utf8', ...(env === undefined ? {} : { env }),
    })
    return stdout
  } catch {
    return null
  }
}

/** Captured head, dirty status, and working-tree snapshot for one workspace read. */
export interface WorkspaceHeadCapture {
  readonly head: string | null
  readonly dirty: boolean | null
  /** Tree hash from {@link snapshotTree}; `null` alongside `head` outside a repository or on failure. */
  readonly tree: string | null
}

/**
 * Write the full current working tree (tracked + untracked, respecting
 * `.gitignore`) as a tree object, without touching the real index: `git add
 * -A .` and `git write-tree` both run against a throwaway `GIT_INDEX_FILE`
 * under `os.tmpdir()`, removed afterward.
 * @param cwd - the session's working directory.
 * @returns the written tree's hash, or `null` outside a repository or on failure.
 */
async function snapshotTree(cwd: string): Promise<string | null> {
  const indexFile = join(tmpdir(), `dsh-training-export-${randomUUID()}.index`)
  const env = { ...process.env, GIT_INDEX_FILE: indexFile }
  try {
    const added = await runGit(cwd, ['add', '-A', '.'], env)
    if (added === null) return null
    const tree = await runGit(cwd, ['write-tree'], env)
    return tree === null ? null : tree.trim()
  } finally {
    // Swallows a missing index file: `git add` may never have created it.
    await rm(indexFile, { force: true }).catch(() => undefined)
  }
}

/**
 * Read the current commit, dirty status, and a working-tree snapshot:
 * `git rev-parse HEAD` then, only when that succeeds, `git status
 * --porcelain` and {@link snapshotTree}.
 * @param cwd - the session's working directory.
 * @returns `{ head: null, dirty: null, tree: null }` outside a repository or on failure.
 */
export async function captureWorkspaceHead(cwd: string): Promise<WorkspaceHeadCapture> {
  const head = await runGit(cwd, ['rev-parse', 'HEAD'])
  if (head === null) return { head: null, dirty: null, tree: null }
  const status = await runGit(cwd, ['status', '--porcelain'])
  const tree = await snapshotTree(cwd)
  return { head: head.trim(), dirty: status === null ? null : status.length > 0, tree }
}

const SHORTSTAT_PATTERN = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/

/**
 * Diff a working-tree snapshot captured at the turn's first sample against a
 * fresh snapshot taken now, so a pre-existing dirty tree does not repeat in
 * every turn's label — only what changed during this turn counts.
 * @param cwd - the session's working directory.
 * @param beforeTree - the tree hash from {@link captureWorkspaceHead} at the turn's first sample.
 * @returns parsed counts, or `null` outside a repository, on failure, or when unchanged.
 */
export async function diffTreeSnapshot(cwd: string, beforeTree: string): Promise<TrainingDiffStat | null> {
  const afterTree = await snapshotTree(cwd)
  if (afterTree === null) return null
  const output = await runGit(cwd, ['diff', '--shortstat', beforeTree, afterTree])
  if (output === null) return null
  const match = SHORTSTAT_PATTERN.exec(output)
  if (match === null) return null
  return {
    files: Number(match[1]),
    insertions: match[2] === undefined ? 0 : Number(match[2]),
    deletions: match[3] === undefined ? 0 : Number(match[3]),
  }
}
