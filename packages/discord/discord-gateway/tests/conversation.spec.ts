import { describe, expect, it, vi } from 'vitest'
import { isAdmitted, boundedContent } from '../src/conversation.ts'
import { BOT_USER, CHANNEL, GUILD_CHANNEL, USER, drain, harness, inbound, record } from './support.ts'

describe('isAdmitted', () => {
  const policy = (overrides: Partial<Parameters<typeof isAdmitted>[1]> = {}) => ({
    allowedUserIds: new Set([USER]),
    allowedChannelIds: new Set([GUILD_CHANNEL]),
    guildRequireMention: false,
    botUserId: () => BOT_USER,
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
      'standing:beardy',
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

  it('warns and posts nothing when a turn outlives its bound, releasing the live handle', async () => {
    const h = harness({ hang: true, turnTimeoutMs: 5 })
    h.router.handle(inbound())
    await drain()
    expect(h.warnings.some(message => message.includes('did not settle within'))).toBe(true)
    expect(h.posted).toEqual([])
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
    expect(h.posted).toEqual([])
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
})
