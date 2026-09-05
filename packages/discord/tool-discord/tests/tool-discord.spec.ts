import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { DiscordPostReply } from '../src/http.ts'
import * as ToolDiscord from '../src/index.ts'
import type { DiscordTransport } from '../src/index.ts'

const CHANNEL = '1478276183543119914'
const RECIPIENT = '138391763999129600'

/** Complete configuration for a definition built without the Loader. */
function config(overrides: Partial<ToolDiscord.ResolvedConfig> = {}): ToolDiscord.ResolvedConfig {
  return {
    tokenEnv: 'DSH_DISCORD_BOT_TOKEN',
    channelId: CHANNEL,
    requestTimeoutMs: 1_000,
    maxRetries: 0,
    maxRetryWaitMs: 5_000,
    maxChunksPerCall: 5,
    dmUserIds: [],
    ...overrides,
  }
}

/** Context carrying only the credential provider the tool reads. */
function contextWithToken(token: string | undefined): Context {
  return {
    credentials: {
      resolve: async () => (token === undefined ? undefined : { value: token, source: 'env' }),
    },
  } as unknown as Context
}

/** Transport that records posted content and direct-message lookups, accepting every message. */
function recordingTransport(replies: readonly DiscordPostReply[] = []): DiscordTransport & {
  posted: string[]
  channels: string[]
  opened: string[]
} {
  const posted: string[] = []
  const channels: string[] = []
  const opened: string[] = []
  return {
    posted,
    channels,
    opened,
    post: async (request) => {
      const reply = replies[posted.length] ?? { status: 200, retryAfterMs: undefined, body: '{"id":"1"}' }
      posted.push(request.content)
      channels.push(request.channelId)
      return reply
    },
    openDm: async (request) => {
      opened.push(request.recipientId)
      return `dm-${request.recipientId}`
    },
    wait: async () => {},
  }
}

function exec(): never {
  return { signal: new AbortController().signal } as never
}

function text(blocks: readonly ContentBlock[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

describe('production transport delay', () => {
  it('resolves after the requested rate-limit delay', async () => {
    const started = Date.now()
    await ToolDiscord.productionTransport.wait(15, new AbortController().signal)
    expect(Date.now() - started).toBeGreaterThanOrEqual(10)
  })

  it('rejects immediately when the call is already cancelled', async () => {
    const controller = new AbortController()
    controller.abort(new Error('job cancelled'))
    await expect(ToolDiscord.productionTransport.wait(5_000, controller.signal)).rejects.toThrow('job cancelled')
  })

  it('rejects when the call is cancelled during a rate-limit delay', async () => {
    const controller = new AbortController()
    const pending = ToolDiscord.productionTransport.wait(5_000, controller.signal)
    setTimeout(() => {
      controller.abort(new Error('cancelled mid-wait'))
    }, 5)
    await expect(pending).rejects.toThrow('cancelled mid-wait')
  })

  it('wraps a cancellation whose reason is not an error', async () => {
    const controller = new AbortController()
    controller.abort('stop')
    await expect(ToolDiscord.productionTransport.wait(5_000, controller.signal)).rejects.toThrow(
      'discord_send was cancelled',
    )
  })
})

describe('discord_send definition', () => {
  it('posts the composed body with the configured channel and resolved token', async () => {
    const transport = recordingTransport()
    const tool = ToolDiscord.createDiscordSendTool(contextWithToken('tok'), config(), transport)
    const value = await tool.execute({ content: 'Morning brief: sunny.' }, exec())
    expect(transport.posted).toEqual(['Morning brief: sunny.'])
    expect(transport.channels).toEqual([CHANNEL])
    expect(value).toEqual({ channelId: CHANNEL, chunks: 1, characters: 21, suppressedBroadcastMentions: 0 })
  })

  it('renders the delivered count for one message', async () => {
    const tool = ToolDiscord.createDiscordSendTool(contextWithToken('tok'), config(), recordingTransport())
    const value = await tool.execute({ content: 'hello there' }, exec())
    expect(text(tool.output.render({ content: 'hello there' }, value))).toBe(
      `Posted 1 Discord message to channel ${CHANNEL} (11 characters).`,
    )
  })

  it('renders plural messages and the broadcast-mention rewrite', async () => {
    const transport = recordingTransport()
    const tool = ToolDiscord.createDiscordSendTool(contextWithToken('tok'), config(), transport)
    const long = `@everyone ${'y'.repeat(2_500)}`
    const value = await tool.execute({ content: long }, exec())
    expect(transport.posted).toEqual(['@\u200beveryone', 'y'.repeat(2_000), 'y'.repeat(500)])
    expect(text(tool.output.render({ content: long }, value))).toBe(
      `Posted 3 Discord messages to channel ${CHANNEL} (2510 characters), rewriting 1 broadcast mention(s).`,
    )
  })

  it('presents a generic pending card carrying the body', () => {
    const tool = ToolDiscord.createDiscordSendTool(contextWithToken('tok'), config(), recordingTransport())
    expect(tool.presentCall?.({ content: 'hello' })).toEqual({
      card: 'generic',
      title: 'Send Discord message',
      kind: 'other',
      rawInput: 'hello',
    })
  })

  it('fails with the credential reference when no token is configured', async () => {
    const transport = recordingTransport()
    const tool = ToolDiscord.createDiscordSendTool(contextWithToken(undefined), config(), transport)
    await expect(tool.execute({ content: 'hello' }, exec())).rejects.toThrow(
      'discord_send: no bot token is configured for "DSH_DISCORD_BOT_TOKEN"',
    )
    expect(transport.posted).toEqual([])
  })

  it('declares the model-facing description and one required parameter', () => {
    const tool = ToolDiscord.createDiscordSendTool(contextWithToken('tok'), config(), recordingTransport())
    const parameters = tool.parameters as { properties?: Record<string, { type?: string }> }
    expect(tool.name).toBe('discord_send')
    expect(tool.description).toContain('The only destination is the configured channel')
    expect(tool.description).toContain('2000 characters')
    expect(Object.keys(parameters.properties ?? {})).toEqual(['content'])
    expect(parameters.properties?.content?.type).toBe('string')
  })

  it.each([
    { label: 'not a number', channelId: 'not-a-snowflake' },
    { label: 'too short', channelId: '1234567890123456' },
  ])('rejects a channelId that is $label', ({ channelId }) => {
    const ctx = { tools: { register: () => () => {} } } as unknown as Context
    expect(() => {
      ToolDiscord.apply(ctx, { ...config(), channelId })
    }).toThrow(/channelId must be a Discord snowflake/)
  })

  it('rejects a negative bound in configuration', () => {
    const ctx = { tools: { register: () => () => {} } } as unknown as Context
    expect(() => {
      ToolDiscord.apply(ctx, { ...config(), maxRetries: -1 })
    }).toThrow(
      'tool-discord: maxRetries must be a non-negative safe integer',
    )
  })

  it('rejects a fractional bound in configuration', () => {
    const ctx = { tools: { register: () => () => {} } } as unknown as Context
    expect(() => {
      ToolDiscord.apply(ctx, { ...config(), requestTimeoutMs: 1.5 })
    }).toThrow(
      'tool-discord: requestTimeoutMs must be a non-negative safe integer',
    )
  })

  it('accepts a configuration whose direct-message allowlist holds snowflakes', () => {
    const registered: string[] = []
    const ctx = { tools: { register: (tool: { name: string }) => {
      registered.push(tool.name)
      return () => {}
    } } } as unknown as Context
    ToolDiscord.apply(ctx, { ...config(), dmUserIds: [RECIPIENT] })
    expect(registered).toEqual(['discord_send'])
  })

  it('rejects a direct-message allowlist entry that is not a snowflake', () => {
    const ctx = { tools: { register: () => () => {} } } as unknown as Context
    expect(() => {
      ToolDiscord.apply(ctx, { ...config(), dmUserIds: ['goran'] })
    }).toThrow('tool-discord: dmUserIds must each be a Discord snowflake of 17 to 20 digits, got "goran"')
  })
})

describe('discord_send direct messaging', () => {
  it('offers the recipient parameter only when the deployment allows direct messages', () => {
    const open = ToolDiscord.createDiscordSendTool(
      contextWithToken('tok'),
      config({ dmUserIds: [RECIPIENT] }),
      recordingTransport(),
    )
    const closed = ToolDiscord.createDiscordSendTool(contextWithToken('tok'), config(), recordingTransport())
    const parameters = open.parameters as { properties?: Record<string, unknown> }
    expect(Object.keys(parameters.properties ?? {})).toEqual(['content', 'recipient'])
    expect(open.description).toContain(RECIPIENT)
    expect(Object.keys((closed.parameters as { properties?: Record<string, unknown> }).properties ?? {})).toEqual(['content'])
  })

  it('opens the direct-message channel of an allowed recipient and posts there', async () => {
    const transport = recordingTransport()
    const tool = ToolDiscord.createDiscordSendTool(
      contextWithToken('tok'),
      config({ dmUserIds: [RECIPIENT] }),
      transport,
    )
    const value = await tool.execute({ content: 'Work is done.', recipient: RECIPIENT }, exec())
    expect(transport.opened).toEqual([RECIPIENT])
    expect(transport.channels).toEqual([`dm-${RECIPIENT}`])
    expect(value.channelId).toBe(`dm-${RECIPIENT}`)
  })

  it('refuses a recipient the deployment did not allow, without posting', async () => {
    const transport = recordingTransport()
    const tool = ToolDiscord.createDiscordSendTool(
      contextWithToken('tok'),
      config({ dmUserIds: [RECIPIENT] }),
      transport,
    )
    await expect(tool.execute({ content: 'hello', recipient: '999999999999999999' }, exec())).rejects.toThrow(
      'discord_send: "999999999999999999" is not an allowed direct-message recipient',
    )
    expect(transport.posted).toEqual([])
    expect(transport.opened).toEqual([])
  })
})
