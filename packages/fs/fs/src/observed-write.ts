/** Version-guarded text writes with the observations used by filesystem policy. */

import type { Context } from '@deepseek-ai/cordis'
import type { FsMutationAllowance, SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { FileSystem } from './index.ts'
import type { FsInfo, FsTarget, FsWriteOutcome } from './types.ts'

/**
 * Write text against the last observed version and publish the resulting version.
 * The caller owns target validation, approval, and the session's sandbox policy.
 * @param ctx - context that records filesystem observations.
 * @param fs - filesystem performing the guarded write.
 * @param target - validated target to write.
 * @param content - complete replacement text.
 * @param existing - stat result that defines the expected version, if present.
 * @param actor - tool execution associated with both observations.
 * @param signal - cancellation for the write.
 * @param sandboxPolicy - caller's resolved sandbox policy.
 * @param allowance - one-use exact home target from an approved trusted tool.
 * @returns the filesystem write outcome.
 */
export async function writeObservedText(
  ctx: Context,
  fs: FileSystem,
  target: FsTarget,
  content: string,
  existing: FsInfo | undefined,
  actor: object | undefined,
  signal: AbortSignal | undefined,
  sandboxPolicy: SandboxExecutionPolicy | undefined,
  allowance?: FsMutationAllowance,
): Promise<FsWriteOutcome> {
  const expected = existing === undefined
    ? { kind: 'createIfAbsent' as const }
    : { kind: 'replaceIfVersion' as const, version: existing.version }
  ctx.emit('fs/observed', target, existing === undefined
    ? { kind: 'absent' }
    : { kind: 'present', version: existing.version }, actor)
  const outcome = await fs.writeText(target, content, expected, signal, sandboxPolicy, allowance)
  ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, actor)
  return outcome
}
