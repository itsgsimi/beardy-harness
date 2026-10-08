import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { installDedicatedPrompt } from '../src/index.ts'

const PROMPT = 'You are one isolated stage. Answer with JSON only.'

describe('installDedicatedPrompt()', () => {
  it('assembles only the dedicated prompt without tools or runtime context, sets the temperature, and disposes', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    ctx.systemPrompt.section({ name: 'generic-persona', order: 10, text: 'You are a coding agent. Use session_search.' })
    ctx.systemPrompt.context({ name: 'runtime', order: 1, text: 'Working directory: /tmp' })
    ctx.systemPrompt.tools(() => ({ schemas: [{ name: 'session_search', description: 'Search', parameters: {} }] }))
    const agent = { session: Session.create(SessionId('dedicated-prompt')) } as Agent
    let scope!: Scope
    await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['systemPrompt'] }))
    const assemble = () => ctx.systemPrompt.assemble({ scope: agent })
    const seed: LlmCallConfig = { provider: 'seed', model: 'seed' }
    const signal = new AbortController().signal
    const request = () => agentEvents(ctx, agent).waterfall('agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed))

    const before = await assemble()
    expect(before.sections.map(section => section.name)).toContain('generic-persona')
    expect(before.tools.map(tool => tool.name)).toEqual(['session_search'])
    expect(before.contexts).not.toEqual([])

    const dispose = installDedicatedPrompt(scope.ctx, { systemPrompt: PROMPT, temperature: 0.2 })
    const isolated = await assemble()
    expect(isolated.sections.map(section => section.text)).toEqual([PROMPT])
    expect(isolated.contexts).toEqual([])
    expect(isolated.tools).toEqual([])
    await expect(request()).resolves.toEqual({ provider: 'seed', model: 'seed', temperature: 0.2 })

    dispose()
    const restored = await assemble()
    expect(restored.sections.map(section => section.name)).toContain('generic-persona')
    expect(restored.tools.map(tool => tool.name)).toEqual(['session_search'])
    await expect(request()).resolves.toBe(seed)
    await ctx.fiber.dispose()
  })
})
