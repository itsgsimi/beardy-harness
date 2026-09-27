/**
 * `SandboxedFileSystem`: the sandbox-enforcing implementation of the
 * `@deepseek-ai/dsh-fs` Service Definition. It extends `LocalFileSystem` so all
 * text-storage mechanics — resolve, stat, read/stream, list, the atomic
 * write and the read-match-write edit critical section — are the local
 * implementation's, verbatim; this package adds the per-call policy fence
 * on mutations. Reads pass through untouched: every mode permits
 * reading.
 *
 * The fence is a policy check in TRUSTED code over a MODEL-CONTROLLED path,
 * NOT a kernel boundary — the operations are the seam's own (open, rename),
 * and only the target path is untrusted, so canonicalize-then-contain is the
 * complete answer to this surface. This is containment, not a security
 * boundary; kernel-grade isolation of untrusted CODE stays `ctx.shell`'s job
 * (`@deepseek-ai/dsh-bash-sandbox`). The residual
 * TOCTOU (an ancestor symlink swapped between the containment re-check and the
 * syscall) is narrowed by re-canonicalizing immediately before delegating and
 * is accepted for this threat model.
 *
 * Per-call policy: `read-only` denies every mutation; `workspace-write` allows
 * a mutation only when the target canonicalizes under the policy's workspace
 * root or a platform temp area from the shared `writableRoots` policy;
 * `danger-full-access` delegates unfenced. A denial throws the structured
 * `FS_SANDBOX_DENIED`.
 *
 * @module @deepseek-ai/dsh-fs-sandbox
 */

import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { Config as LocalConfig } from '@deepseek-ai/dsh-fs-local'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsEditOutcome, FsEditRequest, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { FsMutationAllowance, SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { consumeApprovedFsMutation } from '@deepseek-ai/dsh-sandbox-policy'
import { lstat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { isPathUnder } from './containment.ts'

/**
 * Plugin config: the local backend's knobs verbatim (`cwd` resolution default
 * and `diffBasisMaxBytes` overwrite-presentation bound). The sandbox default
 * (mode + `workspace-write` fallback root) is NOT here — `ctx.sandboxPolicy`
 * resolves each calling session for every enforcing capability.
 */
export type Config = LocalConfig

/**
 * Sandbox-enforcing filesystem backend. Registers as `ctx.fs` (loading it
 * INSTEAD OF `dsh-fs-local`, together with a `ctx.sandboxPolicy`, is the whole
 * swap — the model-facing tools are untouched). Its configured default mode is
 * the capability fact exposed by {@link sandboxMode}; `dsh-tool-fs` resolves
 * each session's mode and cwd into a policy for every mutation, while an
 * approved escalation may stamp a strictly wider mode for one call.
 */
export class SandboxedFileSystem extends LocalFileSystem {
  static inject = ['sandboxPolicy']

  private readonly defaultMode: SandboxMode
  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    this.defaultMode = ctx.sandboxPolicy.defaultMode
  }

  /** The deployment default mode — the capability fact the tool layer reads to advertise escalation. */
  override get sandboxMode(): SandboxMode {
    return this.defaultMode
  }

  /**
   * Fence the write by the per-call policy, then delegate to the inherited
   * atomic write. See {@link checkedTarget}.
   * @param target - the resolved target to write.
   * @param content - the full new file content.
   * @param expected - the write intent guarding the write; omit for unconditional.
   * @param signal - aborts before atomic publication takes effect.
   * @param sandboxPolicy - the per-call mode and workspace root; omit to use
   *   the deployment fallback.
   * @param allowance - one-use exact home target from an approved trusted tool.
   * @returns the write outcome from the inherited backend.
   */
  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
    allowance?: FsMutationAllowance,
  ): Promise<FsWriteOutcome> {
    return super.writeText(await this.checkedTarget(target, sandboxPolicy, allowance), content, expected, signal)
  }

  /**
   * Fence the edit by the per-call policy, then delegate to the inherited
   * atomic edit. See {@link checkedTarget}.
   * @param target - the resolved target to edit.
   * @param edit - the literal search/replace request.
   * @param expected - the version guard; omit for an unconditional edit.
   * @param signal - aborts before atomic publication takes effect.
   * @param sandboxPolicy - the per-call mode and workspace root; omit to use
   *   the deployment fallback.
   * @param allowance - one-use exact home target from an approved trusted tool.
   * @returns the edit outcome from the inherited backend.
   */
  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
    allowance?: FsMutationAllowance,
  ): Promise<FsEditOutcome> {
    return super.editText(await this.checkedTarget(target, sandboxPolicy, allowance), edit, expected, signal)
  }

  /**
   * Fence directory creation with the per-call sandbox policy.
   * @param target - resolved directory target.
   * @param signal - aborts before directory creation takes effect.
   * @param sandboxPolicy - per-call mode and workspace root; omit to use the deployment fallback.
   * @param allowance - one-use exact home target from an approved trusted tool.
   */
  override async makeDirectory(
    target: FsTarget,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
    allowance?: FsMutationAllowance,
  ): Promise<void> {
    return super.makeDirectory(await this.checkedTarget(target, sandboxPolicy, allowance), signal)
  }

  /**
   * Fence regular-file removal with the per-call sandbox policy.
   * @param target - resolved regular-file target.
   * @param signal - aborts before file removal takes effect.
   * @param sandboxPolicy - per-call mode and workspace root; omit to use the deployment fallback.
   * @param allowance - one-use exact home target from an approved trusted tool.
   * @param expectedVersion - observed version required for removal, when supplied.
   */
  override async removeFile(
    target: FsTarget,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
    allowance?: FsMutationAllowance,
    expectedVersion?: FsVersion,
  ): Promise<void> {
    return super.removeFile(await this.checkedTarget(target, sandboxPolicy, allowance), signal, undefined, undefined, expectedVersion)
  }

  /**
   * Enforce the per-call policy against `target` and return the EXACT target the
   * mutation must use, so the checked identity is the mutated one (no
   * check-here-write-there TOCTOU). `read-only` denies; `workspace-write`
   * re-canonicalizes NOW (`resolve` realpaths the deepest existing ancestor,
   * reflecting a concurrently swapped symlink), requires containment under a
   * writable root, and returns THAT fresh target; `danger-full-access` returns
   * the caller's target unfenced. Throws the structured `FS_SANDBOX_DENIED` on
   * refusal — the tool layer maps it to the model-facing `[sandbox: …]` marker
   * and the escalation hint.
   */
  private async checkedTarget(
    target: FsTarget, sandboxPolicy?: SandboxExecutionPolicy, allowance?: FsMutationAllowance,
  ): Promise<FsTarget> {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    const { mode } = policy
    if (mode === 'danger-full-access') return target
    if (mode === 'read-only') {
      throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED')
    }
    // workspace-write: containment on the FRESH canonical path (catches a
    // symlink ancestor swapped since the tool resolved this target), and the
    // mutation delegates with THIS fresh target — never the stale one.
    const fresh = await this.resolve(target.displayPath)
    let contained = false
    for (const root of writableRoots(policy)) {
      if (await isPathUnder(fresh.targetKey, root)) {
        contained = true
        break
      }
    }
    if (!contained && allowance !== undefined) {
      const path = resolve(target.displayPath)
      const suffix = relative(allowance.homePath, path)
      const canonicalHome = await this.resolve(allowance.homePath)
      if (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
        && path === allowance.targetPath && await isPathUnder(fresh.targetKey, canonicalHome.targetKey)
        && await this.hasNoSymlinkAncestors(path, allowance.homePath)) {
        contained = consumeApprovedFsMutation(allowance, path)
      }
    }
    if (!contained) {
      throw new FsError(`cannot write "${target.displayPath}": file access denied under workspace-write mode`, 'FS_SANDBOX_DENIED')
    }
    return fresh
  }

  /** Reject symlinked targets and ancestors, including a symlink at the home itself. */
  private async hasNoSymlinkAncestors(path: string, homePath: string): Promise<boolean> {
    let current = path
    while (true) {
      if (current === homePath) {
        try {
          return (await lstat(current)).isDirectory()
        } catch (error: unknown) {
          /* v8 ignore next -- an unreadable home is a host I/O failure; absent homes are refused below. */
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          return false
        }
      }
      try {
        if ((await lstat(current)).isSymbolicLink()) return false
      } catch (error: unknown) {
        /* v8 ignore next -- resolve rejects non-directory ancestors before this walk; only a concurrent swap reaches this branch. */
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (current !== path) return false
      }
      current = dirname(current)
    }
  }
}

export default SandboxedFileSystem
