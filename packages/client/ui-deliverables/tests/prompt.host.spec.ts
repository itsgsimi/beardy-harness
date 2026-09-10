/** Node-half coverage for the model guidance paired with Web file references. */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { apply, inject } from '../src/index.ts'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

describe('ui-deliverables node plugin', () => {
  it('registers final-response file-reference guidance only while mounted', async () => {
    ctx = new Context()
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    ctx.provide('connection', { fetch: { register: () => () => {} } } as never)
    ctx.provide('sessionQuery', {} as never)
    ctx.provide('sessionController', {} as never)
    ctx.provide('workspaceFiles', {} as never)
    ctx.provide('fs', {} as never)
    ctx.provide('sandboxPolicy', {} as never)
    const mounted = ctx.plugin({ apply, inject })
    await mounted.await()

    const section = (await ctx.systemPrompt.assemble()).sections
      .find(entry => entry.name === 'ui:deliverable-file-references')
    expect(section?.text).toMatchInlineSnapshot('"When you successfully create or modify files, mention the primary outputs in your final response. To make those and any other changed-file references clickable in Web, format them as Markdown inline code using the exact file-tool path, or a basename when unique among the files changed in that turn. When present_visual is available, use it proactively when a visual makes the explanation clearer: charts alongside data analysis, screenshots with browser-test findings, GIFs for motion or interaction, SVGs for diagrams, and self-contained HTML for interactive charts or UI mockups. Create or capture the file first, then call present_visual with a meaningful title and a description of the findings. Keep the supporting explanation in your reply; label illustrative data and distinguish mockups from observed screenshots. HTML mockups must embed their assets and work without external resources. Use present for ordinary final-file delivery. Skip visuals that add no useful information."')

    await mounted.dispose()
    expect((await ctx.systemPrompt.assemble()).sections
      .some(entry => entry.name === 'ui:deliverable-file-references')).toBe(false)
  })
})
