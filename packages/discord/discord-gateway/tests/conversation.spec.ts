import { describe, expect, it, vi } from 'vitest'
import { isAdmitted, boundedContent } from '../src/conversation.ts'
import { BOT_USER, CHANNEL, GUILD_CHANNEL, USER, drain, harness, inbound, record } from './support.ts'

describe('isAdmitted', () => {
  const policy = (overrides: Partial<Parameters<typeof isAdmitted>[1]> = {}) => ({
    allowedUserIds: new Set([USER]),
    allowedChannelIds: new Set([GUILD_CHANNEL]),
    guildRequireMention: false,
    botUserId: () => BOT_USER,
    laneUserIds: new Set<string>(),
    ...overrides,
  })

  it('answers an allowed user in a direct message', () => {
    expect(isAdmitted(inbound(), policy())).toBe(true)
  })

  it('ignores bots, including its own account', () => {
    expect(isAdmitted(inbound({ bot: true }), policy())).toBe(false)
  })

  it('ignores a user the deployment did not allow', () => {
    expect(isAdmitted(inbound({ authorId: '999999999999999999' }), policy())).toBe(false)
  })

  it('reads an allowed guild channel and ignores any other', () => {
    const guild = { guildId: 'g1', channelType: 0 }
    expect(isAdmitted(inbound({ ...guild, channelId: GUILD_CHANNEL }), policy())).toBe(true)
    expect(isAdmitted(inbound({ ...guild, channelId: '111111111111111111' }), policy())).toBe(false)
  })

  it('ignores an unaddressed guild message when mentions are required', () => {
    const guild = { guildId: 'g1', channelType: 0, channelId: GUILD_CHANNEL }
    const mentionPolicy = policy({ guildRequireMention: true })
    expect(isAdmitted(inbound(guild), mentionPolicy)).toBe(false)
  })

  it('admits a guild message that mentions or replies to the bot', () => {
    const guild = { guildId: 'g1', channelType: 0, channelId: GUILD_CHANNEL }
    const mentionPolicy = policy({ guildRequireMention: true })
    expect(isAdmitted(inbound({ ...guild, mentionedUserIds: [BOT_USER] }), mentionPolicy)).toBe(true)
    expect(isAdmitted(inbound({ ...guild, replyToAuthorId: BOT_USER }), mentionPolicy)).toBe(true)
  })

  it('admits no guild message while the bot id is still unknown', () => {
    const guild = { guildId: 'g1', channelType: 0, channelId: GUILD_CHANNEL }
    expect(isAdmitted(inbound({ ...guild, mentionedUserIds: [BOT_USER] }), policy({
      guildRequireMention: true,
      botUserId: () => '',
    }))).toBe(false)
  })

  it('answers direct messages even when mentions are required', () => {
    expect(isAdmitted(inbound(), policy({ guildRequireMention: true }))).toBe(true)
  })
})

describe('boundedContent', () => {
  it('passes text within the bound through unchanged', () => {
    expect(boundedContent('short', 400)).toBe('short')
  })

  it('cuts longer text and marks that the rest did not arrive', () => {
    const cut = boundedContent('x'.repeat(500), 400)
    expect(cut.startsWith('x'.repeat(400))).toBe(true)
    expect(cut).toContain('[truncated by the Discord listener]')
  })
})

describe('conversation router', () => {
  it('opens one session per channel, records it, and posts the agent answer back', async () => {
    const h = harness({ replyText: 'Yes, main is green.' })
    h.router.handle(inbound())
    await drain()
    expect(h.calls).toEqual([
      'permission-resolve:danger-full-access',
      'preset-resolve:beardy',
      'scope:beardy',
      'workspace:/workspace',
      'agent-create',
      'mount:beardy',
      'cmd:new',
      'cmd:status',
      'cmd:stop',
      'attach',
      'permission-set:danger-full-access',
      'title:Discord 1472404859679670455',
      `put:${CHANNEL}`,
      'followup:is the build green?',
      'post',
      `put:${CHANNEL}`,
    ])
    expect(h.posted).toEqual([{ content: 'Yes, main is green.', channelId: CHANNEL, token: 'tok' }])
    const stored = h.table.records.get(CHANNEL)
    expect(stored?.sessionId).toMatch(/^discord-1472404859679670455-/)
    expect(stored?.agentPreset).toBe('beardy')

    h.router.handle(inbound({ id: 'm2', content: 'and the tests?' }))
    await drain()
    expect(h.calls.filter(call => call === 'agent-create')).toHaveLength(1)
    expect(h.calls).toContain('followup:and the tests?')
  })

  it('ignores a message from a user who is not allowed, opening nothing', async () => {
    const h = harness({ replyText: 'nope' })
    h.router.handle(inbound({ authorId: '999999999999999999' }))
    await drain()
    expect(h.calls).toEqual([])
    expect(h.posted).toEqual([])
  })

  it('ignores a message with no text, such as an attachment on its own', async () => {
    const h = harness({ replyText: 'nope' })
    h.router.handle(inbound({ content: '   ' }))
    await drain()
    expect(h.calls).toEqual([])
  })

  it('does not post when the agent answered without text', async () => {
    const h = harness({ replyText: '' })
    h.router.handle(inbound())
    await drain()
    expect(h.calls).not.toContain('post')
  })

  it('notifies the channel when the turn ends with an error', async () => {
    const h = harness()
    h.agent.followup = () => {
      h.events.push({ seq: h.events.length, type: 'turn/end',
        data: { turn: 1, reason: { kind: 'error' } } } as never)
    }
    h.router.handle(inbound())
    await vi.waitFor(() => { expect(h.posted.some(post => post.content.includes('could not finish'))).toBe(true) })
  })

  it('reports a timed-out turn and releases its live handle', async () => {
    const h = harness({ hang: true, turnTimeoutMs: 5 })
    h.router.handle(inbound())
    await drain()
    expect(h.warnings.some(message => message.includes('did not settle within'))).toBe(true)
    expect(h.posted[0]?.content).toContain('request timed out')
    expect(h.handle.dispose).toHaveBeenCalledTimes(1)
    h.releaseIdle()
  })

  it('resumes the recorded session for the message after a timed-out turn', async () => {
    const h = harness({ hang: true, turnTimeoutMs: 5 })
    h.router.handle(inbound())
    await drain()
    expect(h.handle.dispose).toHaveBeenCalledTimes(1)
    h.router.handle(inbound({ id: 'm2', content: 'still there?' }))
    await drain()
    expect(h.calls.some(call => call.startsWith('agent-resume:'))).toBe(true)
    expect(h.calls.filter(call => call === 'agent-create')).toHaveLength(1)
    expect(h.calls).toContain('followup:still there?')
  })

  it('warns when the reply cannot be delivered', async () => {
    const h = harness({ replyText: 'answer', failPost: true })
    h.router.handle(inbound())
    await drain()
    expect(h.warnings.some(message => message.includes('reply to channel'))).toBe(true)
  })

  it('warns when the credential is gone by reply time', async () => {
    const h = harness({ replyText: 'answer', failToken: true })
    h.router.handle(inbound())
    await drain()
    expect(h.warnings.some(message => message.includes('reply to channel'))).toBe(true)
  })

  it('rolls back a session whose workspace attach failed and reports the message failure', async () => {
    const h = harness({ replyText: 'answer', failAttach: true })
    h.router.handle(inbound())
    await drain()
    expect(h.calls).not.toContain('detach')
    expect(h.handle.dispose).toHaveBeenCalledTimes(1)
    expect(h.warnings.some(message => message.includes('message m1 failed'))).toBe(true)
  })

  it('disposes every live conversation and forgets its channels', async () => {
    const h = harness({ replyText: 'answer' })
    h.router.handle(inbound())
    await drain()
    await h.router.dispose()
    expect(h.handle.dispose).toHaveBeenCalledTimes(1)
    await h.router.dispose()
    expect(h.handle.dispose).toHaveBeenCalledTimes(1)
  })

  it('leaves a release timer armed by a disposed router inert', async () => {
    const h = harness({ replyText: 'answer', idleReleaseMs: 5 })
    h.router.handle(inbound())
    await new Promise(resolve => setTimeout(resolve, 2))
    await h.router.dispose()
    const before = h.handle.dispose.mock.calls.length
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.handle.dispose.mock.calls.length).toBe(before)
  })

  it('treats a rejected delay seam as a turn that did not settle', async () => {
    const h = harness({ replyText: 'late', rejectWait: true })
    h.router.handle(inbound())
    await drain()
    expect(h.warnings.some(message => message.includes('did not settle within'))).toBe(true)
    expect(h.posted[0]?.content).toContain('request timed out')
  })

  it('treats a turn that fails outright as one that did not settle', async () => {
    const h = harness({ replyText: 'late', rejectIdle: true })
    h.router.handle(inbound())
    await drain()
    expect(h.warnings.some(message => message.includes('did not settle within'))).toBe(true)
  })

  it('stops waiting when the listener is cancelled while a turn runs', async () => {
    const h = harness({ hang: true, turnTimeoutMs: 5_000 })
    h.router.handle(inbound())
    await new Promise(resolve => setTimeout(resolve, 2))
    h.controller.abort(new Error('listener disposed'))
    await drain()
    expect(h.warnings.some(message => message.includes('did not settle within'))).toBe(true)
  })

  it('reports a cancellation whose reason is not an error object', async () => {
    const h = harness({ hang: true, turnTimeoutMs: 5_000 })
    h.router.handle(inbound())
    await new Promise(resolve => setTimeout(resolve, 2))
    h.controller.abort('listener gone')
    await drain()
    expect(h.warnings.some(message => message.includes('did not settle within'))).toBe(true)
  })

  it('rolls back a session that fails after it was attached', async () => {
    const h = harness({ replyText: 'answer', failTitle: true })
    h.router.handle(inbound())
    await drain()
    expect(h.calls).toContain('detach')
    expect(h.handle.dispose).toHaveBeenCalledTimes(1)
    expect(h.warnings.some(message => message.includes('message m1 failed'))).toBe(true)
  })

  it.each([false, true])('removes a failed Session publication after record write = %s', async (wroteRecord) => {
    const h = harness({ replyText: 'answer' })
    const save = h.table.put
    h.table.put = async (key, value) => {
      if (wroteRecord) await save(key, value)
      throw new Error('routing store failed')
    }
    h.router.handle(inbound())
    await vi.waitFor(() => { expect(h.warnings.some(message => message.includes('message m1 failed'))).toBe(true) })
    expect(h.calls).toContain('detach')
    expect(h.handle.dispose).toHaveBeenCalledTimes(1)
    expect(h.table.records.has(CHANNEL)).toBe(false)
    expect(h.calls.includes(`del:${CHANNEL}`)).toBe(wroteRecord)
  })

  it('posts the answer through the Discord transport when no seam is given', async () => {
    const requests: { url: string; body: string; authorization: string }[] = []
    vi.stubGlobal('fetch', async (input: string | URL, init?: { body?: string; headers?: Record<string, string> }) => {
      requests.push({
        url: String(input),
        body: init?.body ?? '',
        authorization: init?.headers?.['authorization'] ?? '',
      })
      return new Response(JSON.stringify({ id: 'm9' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    try {
      const h = harness({ replyText: 'Build is green.', useDefaultPost: true })
      h.router.handle(inbound())
      await drain()
      expect(requests).toHaveLength(1)
      expect(requests[0]?.url).toBe(`https://discord.com/api/v10/channels/${CHANNEL}/messages`)
      expect(requests[0]?.authorization).toBe('Bot tok')
      expect(requests[0]?.body).toContain('Build is green.')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports a disposal that itself failed', async () => {
    const h = harness({ replyText: 'answer' })
    h.router.handle(inbound())
    await drain()
    h.handle.dispose.mockRejectedValueOnce(new Error('dispose failed'))
    await h.router.dispose()
    expect(h.warnings.some(message => message.includes('disposal of Session'))).toBe(true)
  })

  it('shows the typing indicator while a turn runs when enabled', async () => {
    const h = harness({ replyText: 'later', hang: true, typingIndicator: true, turnTimeoutMs: 5_000 })
    h.router.handle(inbound())
    await drain()
    expect(h.typed).toEqual([CHANNEL])
    h.releaseIdle()
    await drain()
    expect(h.posted).toHaveLength(1)
  })

  it('sends no typing indicator while disabled', async () => {
    const h = harness({ replyText: 'fast', typingIndicator: false })
    h.router.handle(inbound())
    await drain()
    expect(h.typed).toEqual([])
  })

  it('stops the typing loop when the indicator itself fails', async () => {
    const h = harness({ replyText: 'x', hang: true, typingIndicator: true, failType: true, turnTimeoutMs: 5_000 })
    h.router.handle(inbound())
    await drain()
    expect(h.warnings.some(message => message.includes('typing indicator'))).toBe(true)
    h.releaseIdle()
  })

  it.each([200, 403])('handles status reactions through Discord when HTTP returns %i', async (status) => {
    const methods: string[] = []
    vi.stubGlobal('fetch', async (_input: string | URL, init?: { method?: string }) => {
      methods.push(init?.method ?? 'GET')
      return new Response(status === 200 ? '{}' : 'forbidden', { status })
    })
    try {
      const h = harness({ replyText: 'done', reactionStatus: true, useDefaultReact: true })
      h.router.handle(inbound())
      await vi.waitFor(() => { expect(methods).toEqual(['PUT', 'DELETE', 'PUT']) })
      expect(h.warnings.some(message => message.includes('status reaction failed'))).toBe(status === 403)
      await h.router.dispose()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('stops an in-flight status reaction quietly when the listener closes', async () => {
    const started = Promise.withResolvers<undefined>()
    vi.stubGlobal('fetch', async (_input: string | URL, init?: { signal?: AbortSignal }) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('reaction aborted')) }, { once: true })
        started.resolve(undefined)
      }))
    try {
      const h = harness({ replyText: 'done', reactionStatus: true, useDefaultReact: true })
      h.router.handle(inbound())
      await started.promise
      h.controller.abort()
      await h.router.dispose()
      expect(h.warnings.some(message => message.includes('status reaction failed'))).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('abandons the typing loop when the credential is gone', async () => {
    const h = harness({ replyText: 'x', hang: true, typingIndicator: true, failToken: true, turnTimeoutMs: 5_000 })
    h.router.handle(inbound())
    await drain()
    expect(h.typed).toEqual([])
    h.releaseIdle()
  })

  it('reports a disposal that fails while /new releases the conversation', async () => {
    const h = harness({ replyText: 'answer' })
    h.router.handle(inbound())
    await drain()
    h.handle.dispose.mockRejectedValueOnce(new Error('dispose failed'))
    h.router.handle(inbound({ id: 'm2', content: '/new' }))
    await drain()
    expect(h.warnings.some(message => message.includes('disposal of Session'))).toBe(true)
    expect(h.table.records.get(CHANNEL)).toBeUndefined()
  })

  it('treats an aborted typing request as the turn ending, not a failure', async () => {
    const h = harness({ replyText: 'x', hang: true, typingIndicator: true, slowType: true, turnTimeoutMs: 5_000 })
    h.router.handle(inbound())
    await drain()
    h.releaseIdle()
    await drain()
    expect(h.warnings.some(message => message.includes('typing indicator'))).toBe(false)
    expect(h.posted).toHaveLength(1)
  })

  it('keeps serving a second channel independently of the first', async () => {
    const h = harness({ replyText: 'both' })
    h.router.handle(inbound({ channelId: CHANNEL }))
    h.router.handle(inbound({ channelId: GUILD_CHANNEL, id: 'm2' }))
    await drain()
    expect(h.calls.filter(call => call === 'agent-create')).toHaveLength(2)
    expect(h.posted.map(entry => entry.channelId)).toEqual([CHANNEL, GUILD_CHANNEL])
  })

  it('ignores the durable record of a different channel', async () => {
    const h = harness({ replyText: 'fresh', initialRecord: record({ channelId: '999999999999999999' }) })
    h.router.handle(inbound())
    await drain()
    expect(h.calls.filter(call => call === 'agent-create')).toHaveLength(1)
  })

  it('does not run an input stopped while resolving its live conversation', async () => {
    const h = harness({ replyText: 'first' })
    h.router.handle(inbound())
    await drain()
    const originalGet = h.table.get
    let stop: Promise<unknown> | undefined
    let armed = true
    h.table.get = (channelId) => {
      if (armed) {
        armed = false
        stop = h.router.execute(CHANNEL, { userId: USER, directMessage: true }, '/stop')
      }
      return originalGet(channelId)
    }
    h.router.handle(inbound({ id: 'm2', content: 'second' }))
    await vi.waitFor(() => { expect(stop).toBeDefined() })
    await stop
    await drain()
    expect(h.calls.filter(call => call.startsWith('followup:'))).toEqual(['followup:is the build green?'])
  })
})
