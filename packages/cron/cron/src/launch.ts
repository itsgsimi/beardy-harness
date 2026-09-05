/**
 * Running one fired job as an unattended Agent Session: the prompt arrives with cron provenance, the
 * turn runs to completion without a human in front of it, and the Session stays mounted so the run
 * remains readable afterwards. A run that outlives its bound is cancelled and released instead of
 * staying mounted.
 * @module @deepseek-ai/dsh-cron/launch
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { boundContextSummary, createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-workspace'
import type { CronJobSpec, CronRunOutcome } from './types.ts'

/** Everything a run needs from the host and the plugin's configuration. */
export interface JobRunnerDeps {
  /** Context that owns the created Agents, so disposal follows the fiber. */
  readonly ctx: Context
  /** Cancellation of the scheduler these runs belong to. */
  readonly signal: AbortSignal
  /** Longest wait for one run's turn before it is reported as timed out. */
  readonly turnTimeoutMs: number
  /** Delay seam used by the per-run bound. */
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>
}

/** Runner that starts jobs and keeps their Sessions mounted. */
export interface JobRunner {
  /** Run one fire of one job and report how it ended. */
  run(job: CronJobSpec, firedAt: number): Promise<CronRunOutcome>
  /** Runs whose Sessions are still mounted. */
  live(): number
  /** Dispose the oldest runs until at most `max` remain mounted. */
  trim(max: number): Promise<void>
  /** Dispose every Session this runner started. */
  dispose(): Promise<void>
}

/** Sleep until `ms` passes or the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('cron scheduler cancelled'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Wait for one turn to settle within the bound, reporting false otherwise. */
async function settlesInTime(
  idle: Promise<void>,
  timeoutMs: number,
  wait: (ms: number, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): Promise<boolean> {
  const outcome = await new Promise<'idle' | 'timeout'>((resolve) => {
    void wait(timeoutMs, signal).then(
      () => { resolve('timeout') },
      () => { resolve('timeout') },
    )
    idle.then(() => { resolve('idle') }, () => { resolve('timeout') })
  })
  return outcome === 'idle'
}

/** Last assistant text committed at or after `firstSeq`. */
function lastAssistantText(events: readonly SessionEvent[], firstSeq: number): string {
  let text = ''
  for (const event of events) {
    if (event.seq < firstSeq || event.type !== 'assistant/message') continue
    const joined = event.data.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    if (joined !== '') text = joined
  }
  return text
}

/** Title for one run: the configured title, or the job name and fire time. */
export function runTitle(job: CronJobSpec, firedAt: number): string {
  return job.title ?? `${job.name} ${new Date(firedAt).toISOString()}`
}

/**
 * Create a runner that turns cron fires into Agent Sessions.
 *
 * @param deps - host context, scheduler cancellation, turn bound, and the delay seam.
 * @returns the runner, whose {@link JobRunner.dispose} releases every Session it opened.
 */
export function createJobRunner(deps: JobRunnerDeps): JobRunner {
  const { ctx, signal } = deps
  const wait = deps.wait ?? sleep
  const mounted: { sessionId: SessionId; handle: AgentHandle }[] = []

  /** Mount a Session for one fire, with the job's presets and workspace. */
  async function openSession(job: CronJobSpec, firedAt: number): Promise<{ sessionId: SessionId; handle: AgentHandle }> {
    const preset = await ctx.agentPresets.resolve(job.agentPreset)
    ctx.permissionPresets.resolve(job.permissionPreset)
    const workspace = await ctx.workspaceRegistry.create(job.workspacePath)
    const sessionId = SessionId(`cron-${job.name}-${randomUUID()}`)
    const selection = ctx.agentDefaultModel.currentSelection()
    const handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: workspace.path, agentPreset: preset.id },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: async (agentCtx) => {
        await ctx.agentPresets.mount(agentCtx, preset.id)
      },
    })
    let attached = false
    try {
      signal.throwIfAborted()
      await workspace.attachSession(sessionId)
      attached = true
      ctx.permissionPresets.set(handle.agent.session, job.permissionPreset)
      ctx.sessionTitle.rename(handle.agent.session, runTitle(job, firedAt))
    } catch (error: unknown) {
      if (attached) await workspace.detachSession(sessionId)
      await handle.dispose()
      throw error
    }
    return { sessionId, handle }
  }

  return {
    async run(job: CronJobSpec, firedAt: number): Promise<CronRunOutcome> {
      let session: { sessionId: SessionId; handle: AgentHandle }
      try {
        session = await openSession(job, firedAt)
      } catch (error: unknown) {
        ctx.logger.error(`dsh-cron: job "${job.name}" could not start a session: ${errorChain(error)}`)
        return 'failed'
      }
      mounted.push(session)
      const agent = session.handle.agent
      const firstSeq = agent.session.seq
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: job.prompt }],
        source: {
          kind: 'cron',
          jobName: job.name,
          scheduledFor: firedAt,
          form: 'notice',
          summary: boundContextSummary(`Cron job ${job.name}`),
        },
      }))
      if (!await settlesInTime(agent.whenIdle(), deps.turnTimeoutMs, wait, signal)) {
        ctx.logger.warn(`dsh-cron: job "${job.name}" did not settle within ${String(deps.turnTimeoutMs)}ms; `
          + 'the run is cancelled and its session released')
        // The turn must not outlive the scheduler's wait: an undisposed Agent keeps consuming
        // tools and tokens while the next fire sees the job as free and stacks a second Session.
        const index = mounted.indexOf(session)
        if (index !== -1) {
          mounted.splice(index, 1)
          await disposeHandle(ctx, session)
        }
        return 'timed-out'
      }
      const answer = lastAssistantText(agent.session.ownEvents(), firstSeq)
      if (answer === '') {
        ctx.logger.info(`dsh-cron: job "${job.name}" finished without a text answer`)
        return 'no-text-answer'
      }
      ctx.logger.info(`dsh-cron: job "${job.name}" finished in session ${session.sessionId}`)
      return 'answered'
    },

    live(): number {
      return mounted.length
    },

    async trim(max: number): Promise<void> {
      const retired = mounted.splice(0, Math.max(0, mounted.length - max))
      for (const session of retired) await disposeHandle(ctx, session)
    },

    async dispose(): Promise<void> {
      const live = mounted.splice(0)
      for (const session of live) await disposeHandle(ctx, session)
    },
  }
}

/** Dispose one run's Agent, reporting rather than propagating a teardown failure. */
async function disposeHandle(ctx: Context, session: { sessionId: SessionId; handle: AgentHandle }): Promise<void> {
  try {
    await session.handle.dispose()
  } catch (error: unknown) {
    ctx.logger.warn(`dsh-cron: disposal of session ${session.sessionId} failed: ${errorChain(error)}`)
  }
}
