/**
 * Best-effort `git` reads for the spec's `workspace` sample field and
 * `diff` label field. Every call is `execFile` (never a shell), bounded to a
 * 5s timeout, and never throws: any failure (missing `git`, no repository,
 * timeout) reports as `null`.
 * @module @deepseek-ai/dsh-experimental-training-export/workspace
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { TrainingDiffStat } from './types.ts'

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 5_000

/** Run one `git` subcommand; `null` on any failure (non-repo, missing binary, timeout). */
async function runGit(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd, timeout: GIT_TIMEOUT_MS, encoding: 'utf8',
    })
    return stdout
  } catch {
    return null
  }
}

/** Captured head and dirty status for one workspace read. */
export interface WorkspaceHeadCapture {
  readonly head: string | null
  readonly dirty: boolean | null
}

/**
 * Read the current commit and dirty status: `git rev-parse HEAD` then, only
 * when that succeeds, `git status --porcelain`.
 * @param cwd - the session's working directory.
 * @returns `{ head: null, dirty: null }` outside a repository or on failure.
 */
export async function captureWorkspaceHead(cwd: string): Promise<WorkspaceHeadCapture> {
  const head = await runGit(cwd, ['rev-parse', 'HEAD'])
  if (head === null) return { head: null, dirty: null }
  const status = await runGit(cwd, ['status', '--porcelain'])
  return { head: head.trim(), dirty: status === null ? null : status.length > 0 }
}

const SHORTSTAT_PATTERN = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/

/**
 * Read `git diff --shortstat` against a previously captured head.
 * @param cwd - the session's working directory.
 * @param head - the commit captured at the turn's first sample.
 * @returns parsed counts, or `null` outside a repository, on failure, or when unchanged.
 */
export async function diffShortstat(cwd: string, head: string): Promise<TrainingDiffStat | null> {
  const output = await runGit(cwd, ['diff', '--shortstat', head])
  if (output === null) return null
  const match = SHORTSTAT_PATTERN.exec(output)
  if (match === null) return null
  return {
    files: Number(match[1]),
    insertions: match[2] === undefined ? 0 : Number(match[2]),
    deletions: match[3] === undefined ? 0 : Number(match[3]),
  }
}
