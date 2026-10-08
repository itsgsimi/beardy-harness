import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { registerCronApprovalRoute } from '@deepseek-ai/dsh-cron'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { DiscordInteractionId } from '../src/interactions.ts'
import { approvalAsksProjection } from '../src/approval-asks.ts'
import { GUILD_CHANNEL, USER, drain, harness, inbound } from './support.ts'

function cronAgent(): Agent {
  const id = SessionId(`cron-approval-${Math.random()}`)
  const session = Session.create(id)
  session.append('turn/start', { turn: 1 })
  return {
    id, session, options: {}, inbox: unsupportedInbox(), status: 'running', ctx: new Context(),
    send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
  }
}

describe('cron approval through its configured Discord channel', () => {
  it('binds a one-use button to the logged request id and configured channel', async () => {
    const ctx = new Context()
    await ctx.plugin(ApprovalService)
    await ctx.plugin(SessionProjections)
    ctx.sessionProjections.register(approvalAsksProjection)
    const h = harness({ eventContext: ctx, answerers: ['component', 'text'], replyText: 'Conversation ready.' })
    const agent = cronAgent()
    const release = registerCronApprovalRoute(agent, GUILD_CHANNEL)
    try {
      h.router.handle(inbound({ channelId: GUILD_CHANNEL, guildId: GUILD_CHANNEL, channelType: 0, content: 'hello' }))
      await drain()
      const pending = ctx.approval.request({ agent, toolName: 'memory', reason: 'Write to USER.md' })
      await drain()
      expect(h.prompts[0]?.channelId).toBe(GUILD_CHANNEL)
      expect(h.prompts[0]?.content).not.toContain('Reply yes')
      const asked = agent.session.ownEvents().find(event => event.type === 'approval/asked')
      const id = asked?.type === 'approval/asked' ? asked.data.id : ''
      const customId = h.prompts[0]?.components?.[0]?.components[0]?.custom_id ?? ''
      expect(customId).toContain(id)
      h.router.handle(inbound({ channelId: GUILD_CHANNEL, guildId: GUILD_CHANNEL, channelType: 0, content: 'yes' }))
      await drain()
      expect(h.calls.filter(call => call.startsWith('followup:'))).toEqual(['followup:hello'])
      const click = { kind: 'component' as const, id: DiscordInteractionId('1472404859679670461'), applicationId: 'bot-1', channelId: GUILD_CHANNEL, guildId: GUILD_CHANNEL,
        userId: USER, token: 'test', messageId: 'prompt-1', customId, values: [] }
      expect(await h.router.component({ ...click, customId: customId.replace('dsh:', 'other:') })).toContain('no longer available')
      expect(await h.router.component({ ...click, customId: customId.replace(id, 'wrong-request') })).toContain('expired')
      expect(await h.router.component({ ...click, channelId: '1472404859679670499' })).toContain('not available')
      expect(await h.router.component({ ...click, customId: customId.replace(':yes', ':maybe') })).toContain('not valid')
      expect(await h.router.component(click)).toBe('Allowed once.')
      await expect(pending).resolves.toBe('allowed-once')
      expect(await h.router.component(click)).toContain('already answered')
      const decided = agent.session.ownEvents().find(event => event.type === 'approval/decided')
      expect(decided?.type === 'approval/decided' && decided.data.id).toBe(id)
    } finally {
      release()
      await h.router.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('fails closed without a Discord channel, for a Signal target, and on listener restart', async () => {
    const ctx = new Context()
    await ctx.plugin(ApprovalService)
    await ctx.plugin(SessionProjections)
    ctx.sessionProjections.register(approvalAsksProjection)
    const h = harness({ eventContext: ctx, answerers: ['reaction', 'text'] })
    const agent = cronAgent()
    const noChannel = registerCronApprovalRoute(agent)
    await expect(ctx.approval.request({ agent, toolName: 'memory' })).resolves.toBe('unavailable')
    noChannel()
    const signalRoute = registerCronApprovalRoute(agent, 'signal:number:+15551234567')
    await expect(ctx.approval.request({ agent, toolName: 'memory' })).resolves.toBe('unavailable')
    signalRoute()
    const route = registerCronApprovalRoute(agent, `discord:${GUILD_CHANNEL}`)
    const pending = ctx.approval.request({ agent, toolName: 'memory' })
    await drain()
    h.controller.abort()
    await expect(pending).resolves.toBe('cancelled')
    route()
    await h.router.dispose()
    await ctx.fiber.dispose()
  })

  it('refuses a cron request when only ambiguous text answers are configured', async () => {
    const ctx = new Context()
    await ctx.plugin(ApprovalService)
    await ctx.plugin(SessionProjections)
    ctx.sessionProjections.register(approvalAsksProjection)
    const h = harness({ eventContext: ctx, answerers: ['text'] })
    const agent = cronAgent()
    const release = registerCronApprovalRoute(agent, GUILD_CHANNEL)
    try {
      await expect(ctx.approval.request({ agent, toolName: 'memory' })).resolves.toBe('unavailable')
      expect(h.prompts).toHaveLength(0)
      expect(await h.router.component({ kind: 'component', id: DiscordInteractionId('1472404859679670461'),
        applicationId: 'bot-1', channelId: GUILD_CHANNEL, guildId: GUILD_CHANNEL, userId: USER,
        token: 'test', messageId: 'prompt-1', customId: 'dsh:approval:missing:yes', values: [] }))
        .toContain('Native answers are disabled')
    } finally {
      release()
      await h.router.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('does not claim a cron request without a service-issued logged id', async () => {
    const ctx = new Context()
    const h = harness({ eventContext: ctx, answerers: ['reaction'] })
    const agent = cronAgent()
    const release = registerCronApprovalRoute(agent, GUILD_CHANNEL)
    try {
      await expect(ctx.waterfall(scopeTarget(agent, agent), 'approval/request', { agent, toolName: 'memory' },
        async () => 'unavailable' as const)).resolves.toBe('unavailable')
      expect(h.prompts).toHaveLength(0)
    } finally {
      release()
      await h.router.dispose()
      await ctx.fiber.dispose()
    }
  })

  it.each([200, 403])('keeps the decision logged when clearing a native prompt returns HTTP %i', async (patchStatus) => {
    const requests: { method: string; path: string }[] = []
    vi.stubGlobal('fetch', async (input: string | URL, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      requests.push({ method, path: String(input) })
      return method === 'PATCH'
        ? new Response(patchStatus === 200 ? '{}' : 'forbidden', { status: patchStatus })
        : new Response(JSON.stringify({ id: 'cron-prompt' }), { status: 200 })
    })
    const ctx = new Context()
    await ctx.plugin(ApprovalService)
    await ctx.plugin(SessionProjections)
    ctx.sessionProjections.register(approvalAsksProjection)
    const h = harness({ eventContext: ctx, answerers: ['component'], useDefaultPrompt: true, useDefaultClearPrompt: true })
    const agent = cronAgent()
    const release = registerCronApprovalRoute(agent, GUILD_CHANNEL)
    try {
      const pending = ctx.approval.request({ agent, toolName: 'memory' })
      await drain()
      const asked = agent.session.ownEvents().find(event => event.type === 'approval/asked')
      const id = asked?.type === 'approval/asked' ? asked.data.id : ''
      expect(await h.router.component({ kind: 'component', id: DiscordInteractionId('1472404859679670461'),
        applicationId: 'bot-1', channelId: GUILD_CHANNEL, guildId: GUILD_CHANNEL, userId: USER,
        token: 'test', messageId: 'cron-prompt', customId: `dsh:approval:${id}:yes`, values: [] })).toBe('Allowed once.')
      await expect(pending).resolves.toBe('allowed-once')
      await drain()
      expect(requests.map(request => request.method)).toEqual(['POST', 'PATCH'])
      expect(requests[1]?.path).toContain('/messages/cron-prompt')
      expect(h.warnings.some(message => message.includes('presentation failed'))).toBe(patchStatus === 403)
    } finally {
      release()
      await h.router.dispose()
      await ctx.fiber.dispose()
      vi.unstubAllGlobals()
    }
  })

  it('refuses an approval whose prompt exceeds the configured Discord message limit', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const ctx = new Context()
    await ctx.plugin(ApprovalService)
    await ctx.plugin(SessionProjections)
    ctx.sessionProjections.register(approvalAsksProjection)
    const h = harness({ eventContext: ctx, answerers: ['reaction'], useDefaultPrompt: true })
    const agent = cronAgent()
    const release = registerCronApprovalRoute(agent, GUILD_CHANNEL)
    try {
      await expect(ctx.approval.request({ agent, toolName: 'memory', reason: 'x'.repeat(25_000) }))
        .resolves.toBe('unavailable')
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      release()
      await h.router.dispose()
      await ctx.fiber.dispose()
      vi.unstubAllGlobals()
    }
  })

  it('does not report prompt cleanup as a failure when the listener stops during the edit', async () => {
    const patchStarted = Promise.withResolvers<undefined>()
    vi.stubGlobal('fetch', async (_input: string | URL, init?: { method?: string; signal?: AbortSignal }) => {
      if (init?.method !== 'PATCH') return new Response(JSON.stringify({ id: 'cron-prompt' }), { status: 200 })
      return await new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => { reject(new Error('edit aborted')) }, { once: true })
        patchStarted.resolve(undefined)
      })
    })
    const ctx = new Context()
    await ctx.plugin(ApprovalService)
    await ctx.plugin(SessionProjections)
    ctx.sessionProjections.register(approvalAsksProjection)
    const h = harness({ eventContext: ctx, answerers: ['component'], useDefaultPrompt: true, useDefaultClearPrompt: true })
    const agent = cronAgent()
    const release = registerCronApprovalRoute(agent, GUILD_CHANNEL)
    try {
      const pending = ctx.approval.request({ agent, toolName: 'memory' })
      await drain()
      const asked = agent.session.ownEvents().find(event => event.type === 'approval/asked')
      const id = asked?.type === 'approval/asked' ? asked.data.id : ''
      expect(await h.router.component({ kind: 'component', id: DiscordInteractionId('1472404859679670461'),
        applicationId: 'bot-1', channelId: GUILD_CHANNEL, guildId: GUILD_CHANNEL, userId: USER,
        token: 'test', messageId: 'cron-prompt', customId: `dsh:approval:${id}:yes`, values: [] })).toBe('Allowed once.')
      await patchStarted.promise
      h.controller.abort()
      await expect(pending).resolves.toBe('allowed-once')
      await h.router.dispose()
      expect(h.warnings.some(message => message.includes('presentation failed'))).toBe(false)
    } finally {
      release()
      h.controller.abort()
      await h.router.dispose()
      await ctx.fiber.dispose()
      vi.unstubAllGlobals()
    }
  })

  it('expires an unanswered cron request and ignores an unapproved responder', async () => {
    const ctx = new Context()
    await ctx.plugin(ApprovalService)
    await ctx.plugin(SessionProjections)
    ctx.sessionProjections.register(approvalAsksProjection)
    const h = harness({ eventContext: ctx, answerers: ['reaction'], manualWait: true })
    const agent = cronAgent()
    const release = registerCronApprovalRoute(agent, GUILD_CHANNEL)
    try {
      const pending = ctx.approval.request({ agent, toolName: 'memory' })
      await drain()
      h.router.handleReaction({ userId: 'unapproved', channelId: GUILD_CHANNEL, messageId: 'prompt-1', emojiName: '✅' })
      h.router.handleReaction({ userId: USER, channelId: GUILD_CHANNEL, messageId: 'wrong-prompt', emojiName: '✅' })
      h.router.handleReaction({ userId: USER, channelId: GUILD_CHANNEL, messageId: 'prompt-1', emojiName: '❓' })
      expect(h.waitResolvers).toHaveLength(1)
      h.waitResolvers[0]?.()
      await expect(pending).resolves.toBe('cancelled')
      expect(agent.session.ownEvents().find(event => event.type === 'approval/decided')).toMatchObject({
        data: { outcome: 'cancelled' },
      })
    } finally {
      release()
      await h.router.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('does not announce expiry after the run was approved', async () => {
    const ctx = new Context()
    await ctx.plugin(ApprovalService)
    await ctx.plugin(SessionProjections)
    ctx.sessionProjections.register(approvalAsksProjection)
    const h = harness({ eventContext: ctx, answerers: ['reaction'], manualWait: true })
    const agent = cronAgent()
    const release = registerCronApprovalRoute(agent, GUILD_CHANNEL)
    try {
      const pending = ctx.approval.request({ agent, toolName: 'memory' })
      await drain()
      h.router.handleReaction({ userId: USER, channelId: GUILD_CHANNEL, messageId: 'prompt-1', emojiName: '✅' })
      await expect(pending).resolves.toBe('allowed-once')
      h.waitResolvers[0]?.()
      await drain()
      expect(h.posted.some(post => post.content.includes('expired'))).toBe(false)
    } finally {
      release()
      await h.router.dispose()
      await ctx.fiber.dispose()
    }
  })

  describe('names concurrent prompts after their own logged questions', () => {
    async function setup() {
      const ctx = new Context()
      await ctx.plugin(ApprovalService)
      await ctx.plugin(SessionProjections)
      ctx.sessionProjections.register(approvalAsksProjection)
      const h = harness({ eventContext: ctx, answerers: ['component'] })
      const askedIds = (agent: Agent) => agent.session.ownEvents()
        .flatMap(event => event.type === 'approval/asked' ? [event.data.id as string] : [])
      const promptId = (index: number) => h.prompts[index]?.components?.[0]?.components[0]?.custom_id.split(':')[2]
      const click = (messageId: string, id: string) => h.router.component({ kind: 'component', id: DiscordInteractionId('1472404859679670461'),
        applicationId: 'bot-1', channelId: GUILD_CHANNEL, guildId: GUILD_CHANNEL, userId: USER,
        token: 'test', messageId, customId: `dsh:approval:${id}:yes`, values: [] })
      return { ctx, h, askedIds, promptId, click }
    }

    it('answers only the request whose prompt was clicked when two runs ask at once', async () => {
      const { ctx, h, askedIds, promptId, click } = await setup()
      const first = cronAgent()
      const second = cronAgent()
      const releases = [registerCronApprovalRoute(first, GUILD_CHANNEL), registerCronApprovalRoute(second, GUILD_CHANNEL)]
      try {
        const firstPending = ctx.approval.request({ agent: first, toolName: 'memory' })
        const secondPending = ctx.approval.request({ agent: second, toolName: 'memory' })
        await drain()
        expect([promptId(0), promptId(1)]).toEqual([askedIds(first)[0], askedIds(second)[0]])
        await expect(firstPending).resolves.toBe('cancelled')
        expect(await click('prompt-1', askedIds(first)[0] ?? '')).toContain('expired')
        expect(await click('prompt-1', askedIds(second)[0] ?? '')).toBe('Allowed once.')
        await expect(secondPending).resolves.toBe('allowed-once')
      } finally {
        for (const release of releases) release()
        await h.router.dispose()
        await ctx.fiber.dispose()
      }
    })

    it.each([
      ['distinct tool calls', [ToolCallId('call-a'), ToolCallId('call-b')]],
      ['identical questions', [undefined, undefined]],
    ] as const)('claims each logged question once for %s in one Session', async (_label, callIds) => {
      const { ctx, h, askedIds, promptId, click } = await setup()
      const agent = cronAgent()
      const release = registerCronApprovalRoute(agent, GUILD_CHANNEL)
      try {
        const pendings = callIds.map(callId => ctx.approval.request({ agent, toolName: 'memory', ...callId === undefined ? {} : { callId } }))
        await drain()
        const ids = askedIds(agent)
        expect([promptId(0), promptId(1)]).toEqual(ids)
        expect(await click('prompt-1', ids[1] ?? '')).toBe('Allowed once.')
        await expect(Promise.all(pendings)).resolves.toEqual(['cancelled', 'allowed-once'])
        const decided = agent.session.ownEvents().flatMap(event => event.type === 'approval/decided' ? [event.data] : [])
        expect(decided).toEqual([{ id: ids[0], outcome: 'cancelled' }, { id: ids[1], outcome: 'allowed-once' }])
        expect(ctx.sessionProjections.stateOf(agent.session, 'discordApprovalAsks')).toEqual({ undecided: [] })
      } finally {
        release()
        await h.router.dispose()
        await ctx.fiber.dispose()
      }
    })

    it('keeps the reason in the fold and refuses a question already claimed by a live prompt', async () => {
      const { ctx, h, askedIds, promptId, click } = await setup()
      const agent = cronAgent()
      const release = registerCronApprovalRoute(agent, GUILD_CHANNEL)
      try {
        const pending = ctx.approval.request({ agent, toolName: 'memory', callId: ToolCallId('call-a'), reason: 'Write USER.md' })
        await drain()
        expect(ctx.sessionProjections.stateOf(agent.session, 'discordApprovalAsks')).toEqual({
          undecided: [{ id: askedIds(agent)[0], toolName: 'memory', callId: 'call-a', reason: 'Write USER.md' }],
        })
        expect(promptId(0)).toBe(askedIds(agent)[0])
        // A second dispatch with the same fields finds the only matching question already claimed.
        await expect(ctx.waterfall(scopeTarget(agent, agent), 'approval/request',
          { agent, toolName: 'memory', callId: ToolCallId('call-a'), reason: 'Write USER.md' },
          () => Promise.resolve('unavailable' as const))).resolves.toBe('unavailable')
        expect(await click('prompt-1', askedIds(agent)[0] ?? '')).toBe('Allowed once.')
        await expect(pending).resolves.toBe('allowed-once')
      } finally {
        release()
        await h.router.dispose()
        await ctx.fiber.dispose()
      }
    })
  })
})
