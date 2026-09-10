/**
 * Deliverables plugin, node half. Registers the response-format guidance that
 * lets the browser half recognize final-response file references and serves
 * authenticated native opens of declared files. The browser
 * half ships via exports["./client"], discovered through the package.json
 * dsh.client declaration.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { registerPresentOpen } from './present-open.ts'

/** Services required for file-reference guidance and authenticated native opens of declared files. */
export const inject = ['systemPrompt', 'connection', 'sessionQuery', 'sessionController', 'workspaceFiles', 'fs', 'sandboxPolicy']

/** Stable final-response guidance owned by the matching renderer. */
const FILE_REFERENCE_PROMPT = 'When you successfully create or modify files, mention the primary outputs in your final response. '
  + 'To make those and any other changed-file references clickable in Web, format them as Markdown inline code using the exact file-tool path, or a basename when unique among the files changed in that turn. '
  + 'When present_visual is available, use it proactively when a visual makes the explanation clearer: charts alongside data analysis, screenshots with browser-test findings, GIFs for motion or interaction, SVGs for diagrams, and self-contained HTML for interactive charts or UI mockups. '
  + 'Create or capture the file first, then call present_visual with a meaningful title and a description of the findings. Keep the supporting explanation in your reply; label illustrative data and distinguish mockups from observed screenshots. '
  + 'HTML mockups must embed their assets and work without external resources. Use present for ordinary final-file delivery. Skip visuals that add no useful information.'

/**
 * Register model guidance for the file-reference renderer shipped by this package.
 * @param ctx - host context carrying the system-prompt registry.
 */
export function apply(ctx: Context): void {
  registerPresentOpen(ctx)
  ctx.systemPrompt.section({
    name: 'ui:deliverable-file-references',
    order: ctx.systemPrompt.getSectionOrder('DELIVERABLE_FILE_REFERENCES'),
    text: FILE_REFERENCE_PROMPT,
  })
}
