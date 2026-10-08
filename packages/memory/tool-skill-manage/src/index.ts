/**
 * Model-facing skill management and the optional save-it-as-a-skill notice. The plugin registers the
 * `skill_manage` tool over `ctx.fs`, the per-Session nudge over `ctx.sessionProjections`, and the
 * pruned-skill reload guidance as a system-prompt section; skill loading stays in `dsh-tool-skill`.
 * @module @deepseek-ai/dsh-tool-skill-manage
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { applySkillManageTool } from './manage.ts'
import { installSkillNudge } from './nudge.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tool-skill-manage'

/** Services the plugin registers on; `fs` and `sessionProjections` are awaited through nested injects. */
export const inject = ['tools', 'skills', 'systemPrompt']

/**
 * Prompt order of the `tool:skill-manage` section: after the memory tool guidance (2350) and before
 * the goal tool guidance (2400) in the System Prompt service's named section allocation.
 */
export const SKILL_MANAGE_SECTION_ORDER = 2360

const DEFAULT_SKILL_BODY_MAX_BYTES = 32768

/** Model guidance for skill results that context pruning shortened. */
export const PRUNED_SKILL_GUIDANCE = 'If a previously loaded skill result contains the marker [... tool result middle pruned ...], its steps are incomplete: reload that skill by name before acting on it.'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** One notice shown to the model after a tool-heavy turn that saved no skill.
     * Readers preserve the notice without the skill plugin.
     * @persistenceAttribution
     */
    'skill-nudge': {
      readonly kind: 'skill-nudge'
      /** Completed tool calls in the turn this notice reports. */
      readonly toolCalls: number
      readonly form: 'notice'
      readonly summary: string
    }
  }
}

/** Deployment configuration for skill management and the skill nudge. */
export interface Config {
  /** Whether to expose the workspace-local skill_manage mutation tool. */
  enableSkillManagement?: boolean
  /** Whether skill_manage may write the Harness-home user scope; needs enableSkillManagement. */
  enableUserSkillManagement?: boolean
  /** Create, update, and delete ask the approval service before they touch a file. */
  requireApproval?: boolean
  /** Permit approved user-scope mutations in the Harness home under workspace-write. */
  allowApprovedHomeWrites?: boolean
  /** Tool results in one completed turn that trigger the Session's one skill nudge; 0 disables. */
  nudgeAfterToolCalls?: number
  /** Maximum UTF-8 bytes in a skill body written by skill_manage. */
  skillBodyMaxBytes?: number
}

/** Validate and default the skill-management configuration. */
export const Config: z<Config> = z.object({
  enableSkillManagement: z.boolean().default(false),
  enableUserSkillManagement: z.boolean().default(false),
  requireApproval: z.boolean().default(false),
  allowApprovedHomeWrites: z.boolean().default(false),
  nudgeAfterToolCalls: z.number().default(0),
  skillBodyMaxBytes: z.number().default(DEFAULT_SKILL_BODY_MAX_BYTES),
})

/**
 * Register the enabled management tool, nudge, and reload guidance.
 * @param ctx - registrant context carrying the tool registry, skill registry, and prompt-section service.
 * @param config - deployment's management scopes, approval stance, nudge threshold, and body cap.
 */
export function apply(ctx: Context, config: Config): void {
  // The Loader resolves `config` through the `Config` schema, which defaults every field.
  const resolved = config as Required<Config>
  if (resolved.allowApprovedHomeWrites
    && (!resolved.requireApproval || !resolved.enableSkillManagement || !resolved.enableUserSkillManagement)) {
    throw new Error('tool-skill-manage: allowApprovedHomeWrites requires requireApproval, enableSkillManagement, and enableUserSkillManagement')
  }
  assertInteger('nudgeAfterToolCalls', resolved.nudgeAfterToolCalls, 0)
  assertInteger('skillBodyMaxBytes', resolved.skillBodyMaxBytes, 1)

  if (resolved.enableSkillManagement || resolved.nudgeAfterToolCalls > 0) {
    ctx.systemPrompt.section({ name: 'tool:skill-manage', order: SKILL_MANAGE_SECTION_ORDER, text: PRUNED_SKILL_GUIDANCE })
  }
  if (resolved.nudgeAfterToolCalls > 0) ctx.inject(['sessionProjections'], (child) => {
    installSkillNudge(child, resolved.nudgeAfterToolCalls)
  })
  if (resolved.enableSkillManagement) {
    ctx.inject(['fs'], (fsCtx) => {
      applySkillManageTool(fsCtx, fsCtx.fs, {
        enableUserScope: resolved.enableUserSkillManagement,
        requireApproval: resolved.requireApproval,
        allowApprovedHomeWrites: resolved.allowApprovedHomeWrites,
        skillBodyMaxBytes: resolved.skillBodyMaxBytes,
      })
    })
  }
}

function assertInteger(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`tool-skill-manage: ${name} must be an integer greater than or equal to ${String(minimum)}`)
  }
}
