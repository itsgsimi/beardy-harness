import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createConversationRouter, isAdmitted, boundedContent, lastAssistantText } from '../src/conversation.ts'
import type { RoutingPolicy } from '../src/conversation.ts'
import type { DiscordInboundMessage, GatewaySettings } from '../src/types.ts'

const USER = '138391763999129600'
const CHANNEL = '1472404859679670455'
const GUILD_CHANNEL = '1478276183543119914'

const POLICY: RoutingPolicy = { allowedUserIds: new Set([USER]), allowedChannelIds: new Set([GUILD_CHANNEL]) }

const SETTINGS: GatewaySettings = {
  workspacePath: '/workspace',
  agentPreset: 'beardy',
  permissionPreset: 'danger-full-access',
  titlePrefix: 'Discord',
  maxInputChars: 400,
  turnTimeoutMs: 1_000,
}

function inbound(overrides: Partial<DiscordInboundMessage> = {}): DiscordInboundMessage {
  return {
    id: 'm1',
    channelId: CHANNEL,
    guildId: '',
    authorId: USER,
    bot: false,
    channelType: 1,
    content: 'is the build green?',
    ...overrides,
  }
}

interface HarnessOptions {
  /** Per-turn bound for this router; short so an unsettled turn is observable. */
  readonly turnTimeoutMs?: number
  /** Never resolve whenIdle, simulating a turn that outlives its bound. */
  readonly hang?: boolean
  readonly failAttach?: boolean
  readonly failPost?: boolean
  readonly failToken?: boolean
  /** Assistant text the turn commits; empty means the agent answered with no text. */
  readonly replyText?: string
  /** Reject whenIdle, as a turn that fails outright does. */
  readonly rejectIdle?: boolean
  /** Reject the delay seam instead of waiting on the router's own sleep. */
  readonly rejectWait?: boolean
  /** Leave out the post seam so the router's Discord transport runs. */
  readonly useDefaultPost?: boolean
  /** Fail the title step, after the session is already attached. */
  readonly failTitle?: boolean
}

/** Context carrying the services the router touches, recording every call it makes. */
function harness(options: HarnessOptions = {}) {
  const calls: string[] = []
  const events: SessionEvent[] = []
  let idleResolve: () => void = () => {}
  const agent = {
    session: {
      get seq(): number { return events.length },
      events,
    },
    followup(message: { content: readonly { text?: string }[] }) {
      calls.push(`followup:${message.content[0]?.text ?? ''}`)
      if (options.replyText !== undefined) {
        events.push({
          seq: events.length + 1,
          type: 'assistant/message',
          data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: options.replyText }] } },
        } as unknown as SessionEvent)
      }
    },
    whenIdle: () => {
      if (options.rejectIdle) return Promise.reject(new Error('turn failed'))
      return new Promise<void>((resolve) => {
        if (!options.hang) resolve()
        else idleResolve = resolve
      })
    },
  }
  const handle = { agent, dispose: vi.fn(async () => { calls.push('dispose') }) }
  const ctx = {
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    permissionPresets: {
      resolve: (name: string) => { calls.push(`permission-resolve:${name}`); return {} },
      set: (_session: unknown, name: string) => { calls.push(`permission-set:${name}`) },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    agentPresets: {
      resolve: async (name: string) => { calls.push(`preset-resolve:${name}`); return { id: name } },
      mount: async (_ctx: unknown, name: string) => { calls.push(`mount:${name}`) },
    },
    workspaceRegistry: {
      create: async (path: string) => {
        calls.push(`workspace:${path}`)
        return {
          path,
          attachSession: async () => {
            calls.push('attach')
            if (options.failAttach) throw new Error('attach failed')
          },
          detachSession: async () => { calls.push('detach') },
        }
      },
    },
    agents: {
      create: async (options: { setup?: (agentCtx: unknown) => Promise<void> }) => {
        calls.push('agent-create')
        await options.setup?.({ on: () => () => {} })
        return handle
      },
    },
    sessionTitle: {
      rename: (_session: unknown, title: string) => {
        calls.push(`title:${title}`)
        if (options.failTitle) throw new Error('title failed')
      },
    },
  }
  const posted: { content: string; channelId: string; token: string }[] = []
  const controller = new AbortController()
  const router = createConversationRouter({
    ctx: ctx as unknown as Context,
    signal: controller.signal,
    settings: { ...SETTINGS, turnTimeoutMs: options.turnTimeoutMs ?? SETTINGS.turnTimeoutMs },
    policy: POLICY,
    resolveToken: async () => {
      if (options.failToken) throw new Error('no token')
      return 'tok'
    },
    ...(options.rejectWait === true ? { wait: () => Promise.reject(new Error('listener gone')) } : {}),
    ...(options.useDefaultPost ? {} : {
      post: async (content: string, channelId: string, token: string) => {
        calls.push('post')
        if (options.failPost) throw new Error('post failed')
        posted.push({ content, channelId, token })
      },
    }),
  })
  return {
    router, calls, posted, events, agent, handle, controller, ctx: ctx as unknown as Context,
    releaseIdle: () => { idleResolve() },
  }
}

/** Let queued turns run to completion. */
async function drain(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) await new Promise(resolve => setTimeout(resolve, 2))
}

describe('isAdmitted', () => {
  it('answers an allowed user in a direct message', () => {
    expect(isAdmitted(inbound(), POLICY)).toBe(true)
  })

  it('ignores bots, including its own account', () => {
    expect(isAdmitted(inbound({ bot: true }), POLICY)).toBe(false)
  })

  it('ignores a user the deployment did not allow', () => {
    expect(isAdmitted(inbound({ authorId: '999999999999999999' }), POLICY)).toBe(false)
  })

  it('reads an allowed guild channel and ignores any other', () => {
    const guild = { guildId: 'g1', channelType: 0 }
    expect(isAdmitted(inbound({ ...guild, channelId: GUILD_CHANNEL }), POLICY)).toBe(true)
    expect(isAdmitted(inbound({ ...guild, channelId: '111111111111111111' }), POLICY)).toBe(false)
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

describe('lastAssistantText', () => {
  it('returns nothing when no assistant message followed the marker', () => {
    expect(lastAssistantText([], 0)).toBe('')
  })

  it('keeps the last text after the marker and skips earlier events', () => {
    const events = [
      { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'first' }] } } },
      { seq: 2, type: 'turn/end', data: {} },
      { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'second' }] } } },
    ] as unknown as SessionEvent[]
    expect(lastAssistantText(events, 2)).toBe('second')
  })

  it('ignores an assistant message whose text blocks are empty', () => {
    const events = [
      { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '' }] } } },
    ] as unknown as SessionEvent[]
    expect(lastAssistantText(events, 0)).toBe('')
  })
})

describe('conversation router', () => {
  it('opens one session per channel and posts the agent answer back', async () => {
    const h = harness({ replyText: 'Yes, main is green.' })
    h.router.handle(inbound())
    await drain()
    expect(h.calls).toEqual([
      'preset-resolve:beardy',
      'permission-resolve:danger-full-access',
      'workspace:/workspace',
      'agent-create',
      'mount:beardy',
      'attach',
      'permission-set:danger-full-access',
      'title:Discord 1472404859679670455',
      'followup:is the build green?',
      'post',
    ])
    expect(h.posted).toEqual([{ content: 'Yes, main is green.', channelId: CHANNEL, token: 'tok' }])

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

  it('warns and posts nothing when a turn outlives its bound', async () => {
    const h = harness({ hang: true, turnTimeoutMs: 5 })
    h.router.handle(inbound())
    await drain()
    expect(h.ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('did not settle within'))
    expect(h.posted).toEqual([])
    h.releaseIdle()
  })

  it('warns when the reply cannot be delivered', async () => {
    const h = harness({ replyText: 'answer', failPost: true })
    h.router.handle(inbound())
    await drain()
    expect(h.ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('reply to channel'))
  })

  it('warns when the credential is gone by reply time', async () => {
    const h = harness({ replyText: 'answer', failToken: true })
    h.router.handle(inbound())
    await drain()
    expect(h.ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('reply to channel'))
  })

  it('rolls back a session whose workspace attach failed and reports the message failure', async () => {
    const h = harness({ replyText: 'answer', failAttach: true })
    h.router.handle(inbound())
    await drain()
    expect(h.calls).not.toContain('detach')
    expect(h.handle.dispose).toHaveBeenCalledTimes(1)
    expect(h.ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('message m1 failed'))
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

  it('treats a rejected delay seam as a turn that did not settle', async () => {
    const h = harness({ replyText: 'late', rejectWait: true })
    h.router.handle(inbound())
    await drain()
    expect(h.ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('did not settle within'))
    expect(h.posted).toEqual([])
  })

  it('treats a turn that fails outright as one that did not settle', async () => {
    const h = harness({ replyText: 'late', rejectIdle: true })
    h.router.handle(inbound())
    await drain()
    expect(h.ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('did not settle within'))
  })

  it('stops waiting when the listener is cancelled while a turn runs', async () => {
    const h = harness({ hang: true, turnTimeoutMs: 5_000 })
    h.router.handle(inbound())
    await new Promise(resolve => setTimeout(resolve, 2))
    h.controller.abort(new Error('listener disposed'))
    await drain()
    expect(h.ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('did not settle within'))
  })

  it('reports a cancellation whose reason is not an error object', async () => {
    const h = harness({ hang: true, turnTimeoutMs: 5_000 })
    h.router.handle(inbound())
    await new Promise(resolve => setTimeout(resolve, 2))
    h.controller.abort('listener gone')
    await drain()
    expect(h.ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('did not settle within'))
  })

  it('rolls back a session that fails after it was attached', async () => {
    const h = harness({ replyText: 'answer', failTitle: true })
    h.router.handle(inbound())
    await drain()
    expect(h.calls).toContain('detach')
    expect(h.handle.dispose).toHaveBeenCalledTimes(1)
    expect(h.ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('message m1 failed'))
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
    expect(h.ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('disposal of Session'))
  })
})
