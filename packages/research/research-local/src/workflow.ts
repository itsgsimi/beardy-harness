/** Consumer workflow execution inside a durable run. */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ResearchWorkflow, ResearchWorkflowRun } from '@deepseek-ai/dsh-research'
import type { ResearchBudgets, ResearchOwner, ResearchRunId, ResearchSource } from '@deepseek-ai/dsh-research/types'
import type {} from '@deepseek-ai/dsh-attachment'
import { assertTemperature, type ResolvedConfig } from './config.ts'
import type { EngineStorage } from './engine.ts'
import { RESEARCH_STAGE_SYSTEM_PROMPT } from './prompts.ts'
import { runStage, type StageAdmission } from './stage.ts'

/** Largest run or stage deadline a workflow may request, matching the provider's config bound. */
const MAX_WORKFLOW_DEADLINE_MS = 86_400_000

/** Longest stage system prompt a workflow may supply. */
const MAX_STAGE_SYSTEM_PROMPT_CHARS = 4000

/**
 * Reject an unusable workflow before its name, version, deadlines, or stage system prompt enter the run.
 * @param workflow - consumer procedure from a trusted start call.
 * @param budgets - provider budgets the workflow may override.
 * @returns budgets recorded for, and enforced on, this run.
 */
export function workflowBudgets(workflow: ResearchWorkflow, budgets: ResearchBudgets): ResearchBudgets {
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(workflow.name)) throw new Error('research workflow name is invalid')
  if (!workflow.promptVersion.trim() || workflow.promptVersion.length > 100) {
    throw new Error('research workflow promptVersion must be 1 to 100 characters')
  }
  const prompt = workflow.stageSystemPrompt
  if (prompt !== undefined && (!prompt.trim() || prompt.length > MAX_STAGE_SYSTEM_PROMPT_CHARS)) {
    throw new Error(`research workflow stageSystemPrompt must be 1 to ${MAX_STAGE_SYSTEM_PROMPT_CHARS} characters`)
  }
  const resolved = { ...budgets, ...workflow.budgets }
  for (const key of ['hardRunTimeoutMs', 'stageTimeoutMs'] as const) {
    const value = resolved[key]
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_WORKFLOW_DEADLINE_MS) {
      throw new Error(`research workflow ${key} must be an integer from 1 through ${MAX_WORKFLOW_DEADLINE_MS}`)
    }
  }
  return resolved
}

/** Live run facts a workflow execution needs from the provider. */
export interface WorkflowExecution {
  readonly id: ResearchRunId
  readonly parentAgent: Agent
  readonly owner: ResearchOwner
  readonly signal: AbortSignal
  readonly startedAt: number
  readonly contextWindow?: number | undefined
  readonly cwd?: string | undefined
}

/**
 * Execute one workflow and commit its report as the run's completed result.
 * @param ctx - provider context with model, agent, and attachment services.
 * @param admission - provider-wide model stage gate shared with the general engine.
 * @param config - provider route with this run's budgets.
 * @param storage - serialized run writer.
 * @param workflow - consumer procedure.
 * @param execution - run identity, live Agent, owner, cancellation, and stage workspace.
 */
export async function runWorkflow(ctx: Context, admission: StageAdmission, config: ResolvedConfig, storage: EngineStorage,
  workflow: ResearchWorkflow, execution: WorkflowExecution): Promise<void> {
  const { id, parentAgent, owner, signal, startedAt, contextWindow, cwd } = execution
  let round = 0
  const systemPrompt = workflow.stageSystemPrompt ?? RESEARCH_STAGE_SYSTEM_PROMPT
  const run: ResearchWorkflowRun = {
    id,
    signal,
    async stage(prompt, maxTokens, options) {
      signal.throwIfAborted()
      if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error('research workflow stage maxTokens must be positive')
      const temperature = options?.temperature ?? config.stageTemperature
      assertTemperature(temperature, 'research workflow stage temperature')
      if (contextWindow !== undefined && Math.ceil(prompt.length / 3) + maxTokens > contextWindow) {
        throw new Error('research stage input exceeds the model context window')
      }
      const request = { prompt, maxTokens, systemPrompt, temperature, expectJson: options?.expectJson }
      const result = await runStage(ctx, admission, config, id, parentAgent, request, signal, cwd,
        async (stageSessionId) => {
          await storage.checkpoint(id, owner, { round, elapsedMs: Date.now() - startedAt, stageSessionId })
        })
      return result.text
    },
    async search(result) {
      round = Math.max(round, result.round)
      await storage.search(id, owner, result)
    },
    async fetched(page) {
      round = Math.max(round, page.round)
      const bytes = new TextEncoder().encode(page.text)
      const content = await ctx.attachments.saveFile({ data: bytes, name: 'research-source.md' })
      signal.throwIfAborted()
      const source: ResearchSource = {
        url: page.url, requestedUrl: page.requestedUrl, title: page.title, statusCode: page.statusCode,
        retrievedAt: page.retrievedAt, contentSha256: createHash('sha256').update(bytes).digest('hex'), content,
        truncated: page.truncated,
      }
      await storage.source(id, owner, { round: page.round, requestedUrl: page.requestedUrl, finalUrl: page.url,
        statusCode: page.statusCode, retrievedAt: page.retrievedAt, status: 'fetched', source })
      return source
    },
    async failed(attempt) {
      round = Math.max(round, attempt.round)
      await storage.source(id, owner, attempt)
    },
    async finding(result) {
      round = Math.max(round, result.round)
      await storage.finding(id, owner, result)
    },
  }
  const result = await workflow.run(run)
  signal.throwIfAborted()
  await storage.finish(id, owner, { phase: 'completed', markdown: result.markdown, evidence: result.evidence,
    quality: result.quality }, signal)
}
