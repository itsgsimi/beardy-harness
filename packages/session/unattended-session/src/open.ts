/**
 * The shared transaction that opens one unattended root Session: permission and preset resolution,
 * the preset's standing key, workspace creation, Agent creation bound to a cancellation signal,
 * attach, permission-preset application, and titling, with reported rollback of any step a failure
 * lands in. Prompt admission stays with the caller so each ingress keeps its own source block.
 * @module @deepseek-ai/dsh-unattended-session/open
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, AgentSetup } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type { Workspace } from '@deepseek-ai/dsh-workspace'

/** One unattended Session fully specified before it opens. */
export interface UnattendedSessionSpec {
  /** Durable id chosen by the caller, namespaced with the ingress's own prefix. */
  readonly sessionId: SessionId
  /** Agent preset to resolve and mount. */
  readonly agentPreset: string
  /** Permission preset validated at resolution and then applied to the Session. */
  readonly permissionPreset: string
  /** Fully qualified workspace directory that owns the Session. */
  readonly workspacePath: string
  /** Title applied after the attach succeeds. */
  readonly title: string
  /** Provider and model handed to Agent creation; resolved by the caller from its own selection or override. */
  readonly agentOptions: {
    readonly provider: string
    readonly model: string
    readonly maxTokens?: number
  }
  /** Extra setup composed inside the Agent scope after the preset mounts, such as pinning a model selection. */
  readonly setup?: AgentSetup
}

/** One opened unattended Session and the Workspace it is attached to. */
export interface UnattendedSession {
  readonly sessionId: SessionId
  readonly handle: AgentHandle
  readonly workspace: Workspace
}

/** Log a rollback failure without replacing the operation's original failure. */
function reportRollbackFailure(ctx: Context, subject: string, error: unknown): void {
  ctx.logger.warn(`unattended session: ${subject} rollback failed: ${errorChain(error)}`)
}

/**
 * Open one unattended root Session in the order webhook ingress established: permission resolve,
 * preset resolve and its standing key, workspace create, Agent creation bound to `signal`, attach,
 * permission set, title. A failure after Agent creation disposes it (and detaches first when the
 * attach had succeeded); each rollback failure is reported while the original error propagates.
 *
 * @param ctx - runtime context that owns the resulting Agent, so disposal follows the fiber.
 * @param spec - preset, permission, workspace, title, model options, and optional extra setup.
 * @param signal - cancellation of the operation opening this Session.
 * @returns the opened Session's id, Agent handle, and attached Workspace.
 */
export async function openUnattendedSession(
  ctx: Context,
  spec: UnattendedSessionSpec,
  signal: AbortSignal,
): Promise<UnattendedSession> {
  ctx.permissionPresets.resolve(spec.permissionPreset)
  const preset = await ctx.agentPresets.resolve(spec.agentPreset)
  await ctx.agentPresets.standingKeyFor(preset.id)
  signal.throwIfAborted()

  const workspace = await ctx.workspaceRegistry.create(spec.workspacePath)
  signal.throwIfAborted()
  const handle = await ctx.agents.create({
    sessionId: spec.sessionId,
    signal,
    meta: { cwd: workspace.path, agentPreset: preset.id },
    agentOptions: spec.agentOptions,
    setup: async (agentCtx, agent) => {
      await ctx.agentPresets.mount(agentCtx, preset.id)
      return spec.setup?.(agentCtx, agent)
    },
  })

  let attached = false
  try {
    signal.throwIfAborted()
    await workspace.attachSession(spec.sessionId)
    attached = true
    signal.throwIfAborted()
    ctx.permissionPresets.set(handle.agent.session, spec.permissionPreset)
    ctx.sessionTitle.rename(handle.agent.session, spec.title)
  } catch (error: unknown) {
    if (attached) {
      try {
        await workspace.detachSession(spec.sessionId)
      } catch (rollbackError: unknown) {
        reportRollbackFailure(ctx, `Workspace detach for Session "${spec.sessionId}"`, rollbackError)
      }
    }
    try {
      await handle.dispose()
    } catch (rollbackError: unknown) {
      reportRollbackFailure(ctx, `Agent disposal for Session "${spec.sessionId}"`, rollbackError)
    }
    throw error
  }
  return { sessionId: spec.sessionId, handle, workspace }
}

/** One resumed unattended Session, specified by the durable identity its ingress already holds. */
export interface ResumeUnattendedSessionSpec {
  /** Durable id of the persisted Session to load and continue. */
  readonly sessionId: SessionId
  /** Agent preset to resolve and mount onto the resumed Session. */
  readonly agentPreset: string
  /** Permission preset validated at resolution and then applied to the Session. */
  readonly permissionPreset: string
  /** Fully qualified workspace directory that owns the Session. */
  readonly workspacePath: string
  /** Provider and model handed to Agent resume; resolved by the caller from its own selection. */
  readonly agentOptions: {
    readonly provider: string
    readonly model: string
    readonly maxTokens?: number
  }
  /** Extra setup composed inside the Agent scope after the preset mounts. */
  readonly setup?: AgentSetup
}

/**
 * Resume one persisted unattended root Session in the same order {@link openUnattendedSession}
 * creates it, substituting `ctx.agents.resume` for creation and leaving the stored title alone.
 * A missing durable log rejects with `SessionPersistenceNotFoundError`; every other failure keeps
 * its own cause. A failure after Agent resume disposes it (detaching first when the attach had
 * succeeded), reporting each rollback failure while the original error propagates.
 *
 * @param ctx - runtime context that owns the resulting Agent, so disposal follows the fiber.
 * @param spec - persisted id, preset, permission, workspace, model options, and optional extra setup.
 * @param signal - cancellation of the operation resuming this Session.
 * @returns the resumed Session's id, Agent handle, and attached Workspace.
 */
export async function resumeUnattendedSession(
  ctx: Context,
  spec: ResumeUnattendedSessionSpec,
  signal: AbortSignal,
): Promise<UnattendedSession> {
  ctx.permissionPresets.resolve(spec.permissionPreset)
  const preset = await ctx.agentPresets.resolve(spec.agentPreset)
  await ctx.agentPresets.standingKeyFor(preset.id)
  signal.throwIfAborted()

  const workspace = await ctx.workspaceRegistry.create(spec.workspacePath)
  signal.throwIfAborted()
  const handle = await ctx.agents.resume({
    resumeSessionId: spec.sessionId,
    agentOptions: spec.agentOptions,
    signal,
    setup: async (agentCtx, agent) => {
      await ctx.agentPresets.mount(agentCtx, preset.id)
      return spec.setup?.(agentCtx, agent)
    },
  })

  let attached = false
  try {
    signal.throwIfAborted()
    await workspace.attachSession(spec.sessionId)
    attached = true
    signal.throwIfAborted()
    ctx.permissionPresets.set(handle.agent.session, spec.permissionPreset)
  } catch (error: unknown) {
    if (attached) {
      try {
        await workspace.detachSession(spec.sessionId)
      } catch (rollbackError: unknown) {
        reportRollbackFailure(ctx, `Workspace detach for Session "${spec.sessionId}"`, rollbackError)
      }
    }
    try {
      await handle.dispose()
    } catch (rollbackError: unknown) {
      reportRollbackFailure(ctx, `Agent disposal for Session "${spec.sessionId}"`, rollbackError)
    }
    throw error
  }
  return { sessionId: spec.sessionId, handle, workspace }
}
