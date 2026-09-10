/**
 * Running one fired job as an unattended Agent Session: the prompt arrives with cron provenance, the
 * turn runs to completion without a human in front of it, and the Session stays mounted so the run
 * remains readable afterwards. A run that outlives its bound is cancelled and released instead of
 * staying mounted.
 * @module @deepseek-ai/dsh-cron/launch
 */

/* jscpd:ignore-start -- consumers list the same service modules for side-effect types; shared logic lives in dsh-unattended-session */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { boundContextSummary, createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import { sleep, lastAssistantText, openUnattendedSession, type UnattendedSession } from '@deepseek-ai/dsh-unattended-session'
import type {} from '@deepseek-ai/dsh-workspace'
/* jscpd:ignore-end */
import type { CronJobSpec, CronRunResult, ScheduledJobSpec } from './types.ts'

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

/** Continuity instruction appended to every run prompt so notes carry between fires. */
export const CONTINUITY_WITH_NOTES =
  'Your notes from earlier runs follow. Do not repeat what was already reported; continue from there. '
  + 'Update the notes with the cron_manage tool, action "note", before you finish.'

/**
 * Continuity instruction for a first run, which has no notes to continue from.
 * @param jobName - Job whose next run receives the saved notes.
 * @returns Instruction to save notes before the run finishes.
 */
export const CONTINUITY_WITHOUT_NOTES = (jobName: string): string =>
  `Before you finish, record what the next run of "${jobName}" should know with the cron_manage tool, action "note".`

/**
 * Compose the full prompt text for one fire: task, delivery guidance, continuity instruction, and notes.
 * @param job - Current job definition, delivery destination, and continuity notes.
 * @returns Text submitted to the run's Session as its first message.
 */
export function runPrompt(job: ScheduledJobSpec): string {
  const prompt = job.deliverChannelId === undefined ? job.prompt : `${job.prompt}

Your final answer will be delivered to the configured channel automatically. Put the content to deliver in your final answer; do not send the same content separately with discord_send.`
  if (job.notes === '') return `${prompt}

${CONTINUITY_WITHOUT_NOTES(job.name)}`
  return `${prompt}

${CONTINUITY_WITH_NOTES}

Notes from earlier runs:
${job.notes}`
}

/** Runner that starts jobs and keeps their Sessions mounted. */
export interface JobRunner {
  /** Run one fire of one job and report how it ended, with its session and final text. */
  run(job: ScheduledJobSpec, firedAt: number, sessionId?: SessionId): Promise<CronRunResult>
  /** Runs whose Sessions are still mounted. */
  live(): number
  /** Dispose the oldest runs until at most `max` remain mounted. */
  trim(max: number): Promise<void>
  /** Dispose every Session this runner started. */
  dispose(): Promise<void>
}

/**
 * Title for one run: the configured title, or the job name and fire time.
 * @param job - Job definition with its name and optional title.
 * @param firedAt - Epoch milliseconds when this run fired.
 * @returns Session title for the run.
 */
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
  const mounted: UnattendedSession[] = []
  const completed = new Set<UnattendedSession>()

  /** Mount a Session for one fire, with the job's presets and workspace. */
  async function openSession(job: CronJobSpec, firedAt: number, sessionId: SessionId): Promise<UnattendedSession> {
    const selection = ctx.agentDefaultModel.currentSelection()
    return await openUnattendedSession(ctx, {
      sessionId,
      agentPreset: job.agentPreset,
      permissionPreset: job.permissionPreset,
      workspacePath: job.workspacePath,
      title: runTitle(job, firedAt),
      agentOptions: { provider: selection.provider, model: selection.model },
    }, signal)
  }

  return {
    async run(job: ScheduledJobSpec, firedAt: number, sessionId = SessionId(`cron-${job.name}-${randomUUID()}`)): Promise<CronRunResult> {
      let session: UnattendedSession | undefined
      const bound = new AbortController()
      const runSignal = AbortSignal.any([signal, bound.signal])
      try {
        signal.throwIfAborted()
        session = await openSession(job, firedAt, sessionId)
        mounted.push(session)
        signal.throwIfAborted()
        const agent = session.handle.agent
        const firstSeq = agent.session.seq
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: runPrompt(job) }],
          source: {
            kind: 'cron',
            jobName: job.name,
            scheduledFor: firedAt,
            form: 'notice',
            summary: boundContextSummary(`Cron job ${job.name}`),
          },
        }))
        signal.throwIfAborted()
        const outcome = await Promise.race([
          agent.whenIdle().then(() => 'idle' as const),
          (deps.wait ?? sleep)(deps.turnTimeoutMs, runSignal).then(() => 'timeout' as const),
        ])
        if (outcome === 'timeout') {
          ctx.logger.warn(`dsh-cron: job "${job.name}" did not settle within ${String(deps.turnTimeoutMs)}ms; `
            + 'the run is cancelled and its session released')
          await release(session)
          return { outcome: 'timed-out', sessionId, text: '' }
        }
        signal.throwIfAborted()
        const answer = lastAssistantText(agent.session.ownEvents(), firstSeq)
        completed.add(session)
        if (answer === '') {
          ctx.logger.info(`dsh-cron: job "${job.name}" finished without a text answer`)
          return { outcome: 'no-text-answer', sessionId, text: '' }
        }
        ctx.logger.info(`dsh-cron: job "${job.name}" finished in session ${sessionId}`)
        return { outcome: 'answered', sessionId, text: answer }
      } catch (error: unknown) {
        if (session !== undefined) await release(session)
        if (signal.aborted) return { outcome: 'interrupted', sessionId, text: '' }
        const failure = session === undefined ? 'could not start a session' : 'run reported a failure'
        ctx.logger.error(`dsh-cron: job "${job.name}" ${failure}: ${errorChain(error)}`)
        return { outcome: 'failed', sessionId, text: '' }
      } finally {
        bound.abort(new Error('cron turn settled'))
      }
    },

    live(): number {
      return mounted.length
    },

    async trim(max: number): Promise<void> {
      const retired = [...completed].slice(0, Math.max(0, completed.size - max))
      for (const session of retired) await release(session)
    },

    async dispose(): Promise<void> {
      for (const session of [...mounted]) await release(session)
    },
  }

  async function release(session: UnattendedSession): Promise<void> {
    const index = mounted.indexOf(session)
    if (index !== -1) {
      mounted.splice(index, 1)
      completed.delete(session)
      await disposeHandle(ctx, session)
    }
  }
}

/** Dispose one run's Agent, reporting rather than propagating a teardown failure. */
async function disposeHandle(ctx: Context, session: UnattendedSession): Promise<void> {
  try {
    await session.handle.dispose()
  } catch (error: unknown) {
    ctx.logger.warn(`dsh-cron: disposal of session ${session.sessionId} failed: ${errorChain(error)}`)
  }
}
