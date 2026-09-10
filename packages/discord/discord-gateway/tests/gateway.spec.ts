import { describe, expect, it, vi } from 'vitest'
import {
  DISCORD_GATEWAY_INTENTS,
  DISCORD_GATEWAY_URL,
  DiscordGatewayOpcode,
  connectDiscordGateway,
  parseMessageCreate,
  parseMessageReaction,
} from '../src/gateway.ts'
import type { GatewaySocket, GatewaySocketEvent } from '../src/gateway.ts'
import type { DiscordInboundMessage, DiscordInboundReaction, GatewayStatus } from '../src/types.ts'
import type { DiscordInteraction } from '../src/interactions.ts'

/** Socket the client drives, with the test deciding what the gateway says. */
class FakeSocket implements GatewaySocket {
  readonly sent: Record<string, unknown>[] = []
  closeCount = 0
  sendThrows = false
  /** Answer every heartbeat the way a healthy gateway does. */
  autoAck = false
  private readonly listeners = new Map<GatewaySocketEvent, ((payload: unknown) => void)[]>()

  send(data: string): void {
    if (this.sendThrows) throw new Error('socket refuses writes')
    const payload = JSON.parse(data) as Record<string, unknown>
    this.sent.push(payload)
    if (this.autoAck && payload['op'] === DiscordGatewayOpcode.heartbeat) {
      this.frame({ op: DiscordGatewayOpcode.heartbeatAck, d: null, s: null, t: null })
    }
  }

  close(): void {
    this.closeCount += 1
    this.emit('close', { code: 1006 })
  }

  on(event: GatewaySocketEvent, listener: (payload: unknown) => void): () => void {
    const current = this.listeners.get(event) ?? []
    this.listeners.set(event, [...current, listener])
    return () => {
      this.listeners.set(event, (this.listeners.get(event) ?? []).filter(entry => entry !== listener))
    }
  }

  emit(event: GatewaySocketEvent, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload)
  }

  /** Deliver one gateway frame as a websocket message event. */
  frame(frame: Record<string, unknown>): void {
    this.emit('message', { data: JSON.stringify(frame) })
  }

  /** Payload the client sent with the given opcode, or undefined. */
  payload(op: number): Record<string, unknown> | undefined {
    return this.sent.find(entry => entry['op'] === op)
  }
}

/** Run the client against sockets the test hands out, stopping it when the body resolves. */
async function withGateway(
  run: (sockets: FakeSocket[], statuses: GatewayStatus[]) => Promise<void>,
  options: {
    readonly reconnectDelayMs?: number
    readonly onMessage?: (message: DiscordInboundMessage) => void
    readonly onReady?: (botUserId: string, applicationId: string) => void
    readonly onReaction?: (reaction: DiscordInboundReaction) => void
    readonly onInteraction?: (interaction: DiscordInteraction) => void
  } = {},
): Promise<void> {
  const sockets: FakeSocket[] = []
  const statuses: GatewayStatus[] = []
  const controller = new AbortController()
  const connecting = connectDiscordGateway({
    token: 'tok',
    socketFactory: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    onMessage: options.onMessage ?? (() => {}),
    onStatus: status => statuses.push(status),
    ...(options.onReady === undefined ? {} : { onReady: options.onReady }),
    ...(options.onReaction === undefined ? {} : { onReaction: options.onReaction }),
    ...(options.onInteraction === undefined ? {} : { onInteraction: options.onInteraction }),
    reconnectDelayMs: options.reconnectDelayMs ?? 5,
    maxReconnectDelayMs: 5,
  }, controller.signal)
  try {
    await run(sockets, statuses)
  } finally {
    controller.abort(new Error('test over'))
    await connecting
  }
}

/** Let queued microtasks, heartbeat beats, and one reconnect delay pass. */
async function tick(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await new Promise(resolve => setTimeout(resolve, 4))
}

describe('parseMessageCreate', () => {
  it('reduces a dispatch payload to the fields routing needs', () => {
    const message = parseMessageCreate({
      id: 'm1',
      channel_id: 'c1',
      guild_id: 'g1',
      channel_type: 0,
      content: 'hello',
      author: { id: 'u1', bot: true },
    })
    expect(message).toEqual({
      id: 'm1', channelId: 'c1', guildId: 'g1', authorId: 'u1', bot: true, channelType: 0, content: 'hello',
      mentionedUserIds: [], replyToAuthorId: '',
    })
  })

  it('reads mention ids and the author of a replied-to message', () => {
    const message = parseMessageCreate({
      id: 'm1', channel_id: 'c1', author: { id: 'u1' }, content: 'you',
      mentions: [{ id: 'bot1' }, 'junk', {}, { id: 'user2' }],
      referenced_message: { author: { id: 'bot1' } },
    })
    expect(message?.mentionedUserIds).toEqual(['bot1', 'user2'])
    expect(message?.replyToAuthorId).toBe('bot1')
  })

  it('parses a reaction dispatch into its four routing fields', () => {
    const reaction = parseMessageReaction({
      user_id: 'u1', channel_id: 'c1', message_id: 'm1', emoji: { name: '✅' },
    })
    expect(reaction).toEqual({ userId: 'u1', channelId: 'c1', messageId: 'm1', emojiName: '✅' })
  })

  it('discards reactions missing an id or carrying a malformed emoji', () => {
    expect(parseMessageReaction(undefined)).toBeUndefined()
    expect(parseMessageReaction({ channel_id: 'c1', message_id: 'm1', emoji: { name: 'x' } })).toBeUndefined()
    expect(parseMessageReaction({ user_id: 'u1', channel_id: 'c1', message_id: 'm1' })?.emojiName).toBe('')
  })

  it('reads no reply author when the referenced message carries none', () => {
    const message = parseMessageCreate({
      id: 'm1', channel_id: 'c1', author: { id: 'u1' },
      referenced_message: { author: null, content: 'quoted' },
    })
    expect(message?.replyToAuthorId).toBe('')
  })

  it('defaults absent mentions and replies to empty', () => {
    const message = parseMessageCreate({
      id: 'm1', channel_id: 'c1', author: { id: 'u1' },
      mentions: 'junk', referenced_message: { author: {} },
    })
    expect(message?.mentionedUserIds).toEqual([])
    expect(message?.replyToAuthorId).toBe('')
  })

  it('defaults a missing guild, channel type, and bot flag', () => {
    expect(parseMessageCreate({ id: 'm1', channel_id: 'c1', author: { id: 'u1' } })).toMatchObject({
      guildId: '', channelType: 1, bot: false, content: '',
    })
    expect(parseMessageCreate({ id: 'm2', channel_id: 'c2', guild_id: 'g2', author: { id: 'u1' } }))
      .toMatchObject({ guildId: 'g2', channelType: 0 })
  })

  it.each([
    ['no payload', null],
    ['no author', { id: 'm1', channel_id: 'c1' }],
    ['no message id', { channel_id: 'c1', author: { id: 'u1' } }],
    ['no channel id', { id: 'm1', author: { id: 'u1' } }],
    ['no author id', { id: 'm1', channel_id: 'c1', author: {} }],
  ])('discards %s', (_label, payload) => {
    expect(parseMessageCreate(payload)).toBeUndefined()
  })
})

describe('connectDiscordGateway', () => {
  it('dispatches validated native interactions and ignores malformed interaction identities', async () => {
    const interactions: DiscordInteraction[] = []
    await withGateway(async (sockets) => {
      const data = {
        id: '1472404859679670455', application_id: '138391763999129600', token: 'private-token',
        channel_id: '138391763999129602', user: { id: '138391763999129601' }, type: 2,
        data: { type: 1, name: 'status' },
      }
      sockets[0]!.frame({ op: 0, t: 'INTERACTION_CREATE', s: 1, d: data })
      sockets[0]!.frame({ op: 0, t: 'INTERACTION_CREATE', s: 2, d: { ...data, id: 'invalid' } })
      expect(interactions).toHaveLength(1)
      expect(interactions[0]).toMatchObject({ kind: 'command', name: 'status', arguments: '' })
    }, { onInteraction: interaction => interactions.push(interaction) })
  })

  it('identifies with the token and intents as soon as the socket opens', async () => {
    await withGateway(async (sockets) => {
      sockets[0]!.emit('open', undefined)
      await tick()
      expect(sockets[0]!.payload(DiscordGatewayOpcode.identify)).toMatchObject({
        d: { token: 'tok', intents: DISCORD_GATEWAY_INTENTS },
      })
    })
  })

  it('beats at the announced interval and carries the last sequence number', async () => {
    await withGateway(async (sockets) => {
      sockets[0]!.autoAck = true
      sockets[0]!.emit('open', undefined)
      sockets[0]!.frame({ op: DiscordGatewayOpcode.hello, d: { heartbeat_interval: 3 }, s: 41, t: null })
      await tick(6)
      const beats = sockets[0]!.sent.filter(entry => entry['op'] === DiscordGatewayOpcode.heartbeat)
      expect(beats.length).toBeGreaterThanOrEqual(2)
      expect(beats[0]).toEqual({ op: DiscordGatewayOpcode.heartbeat, d: 41 })
    })
  })

  it('closes a connection that stops acknowledging heartbeats and reconnects', async () => {
    await withGateway(async (sockets) => {
      sockets[0]!.emit('open', undefined)
      sockets[0]!.frame({ op: DiscordGatewayOpcode.hello, d: { heartbeat_interval: 2 }, s: null, t: null })
      await tick(8)
      expect(sockets.length).toBeGreaterThan(1)
    }, {})
  })

  it('reports a connection that closes and opens another one', async () => {
    const statuses: GatewayStatus[] = []
    await withGateway(async (sockets, reported) => {
      sockets[0]!.emit('open', undefined)
      sockets[0]!.close()
      await tick()
      expect(reported).toContainEqual({ kind: 'disconnected', reason: 'socket closed with code 1006' })
      expect(sockets.length).toBeGreaterThan(1)
    })
    expect(statuses.length).toBeGreaterThanOrEqual(0)
  })

  it('hands every MESSAGE_CREATE dispatch to the callback and ignores other events', async () => {
    const messages: DiscordInboundMessage[] = []
    const readyIds: [string, string][] = []
    await withGateway(async (sockets, statuses) => {
      sockets[0]!.frame({
        op: DiscordGatewayOpcode.dispatch,
        t: 'MESSAGE_CREATE',
        s: 7,
        d: { id: 'm1', channel_id: 'c1', author: { id: 'u1' }, content: 'hi' },
      })
      sockets[0]!.frame({
        op: DiscordGatewayOpcode.dispatch,
        t: 'READY',
        s: 8,
        d: { user: { id: 'bot-1' }, application: { id: 'app-1' } },
      })
      sockets[0]!.frame({ op: DiscordGatewayOpcode.dispatch, t: 'READY', s: 9, d: {} })
      await tick()
      expect(statuses).toContainEqual({ kind: 'ready' })
    }, { onMessage: message => messages.push(message), onReady: (userId, applicationId) => readyIds.push([userId, applicationId]) })
    expect(messages).toHaveLength(1)
    expect(messages[0]?.channelId).toBe('c1')
    expect(readyIds).toEqual([['bot-1', 'app-1']])
  })

  it('keeps bot identity separate when READY has no usable application identity', async () => {
    const readyIds: [string, string][] = []
    await withGateway(async (sockets) => {
      for (const application of [undefined, null, {}, [], { id: 123 }]) {
        sockets[0]!.frame({ op: DiscordGatewayOpcode.dispatch, t: 'READY', s: 1,
          d: { user: { id: 'bot-1' }, application } })
      }
      await tick()
    }, { onReady: (userId, applicationId) => readyIds.push([userId, applicationId]) })
    expect(readyIds).toEqual(Array.from({ length: 5 }, () => ['bot-1', '']))
  })

  it('hands every MESSAGE_REACTION_ADD dispatch to the reaction callback', async () => {
    const reactions: DiscordInboundReaction[] = []
    await withGateway(async (sockets) => {
      sockets[0]!.frame({
        op: DiscordGatewayOpcode.dispatch, t: 'MESSAGE_REACTION_ADD', s: 8,
        d: { user_id: 'u1', channel_id: 'c1', message_id: 'm1', emoji: { name: '✅' } },
      })
      await tick()
    }, { onReaction: reaction => reactions.push(reaction) })
    expect(reactions).toEqual([{ userId: 'u1', channelId: 'c1', messageId: 'm1', emojiName: '✅' }])
  })

  it('ignores dispatch events the listener does not consume', async () => {
    const messages: DiscordInboundMessage[] = []
    await withGateway(async (sockets, statuses) => {
      sockets[0]!.frame({ op: DiscordGatewayOpcode.dispatch, t: 'GUILD_CREATE', s: 6, d: { id: 'g1' } })
      await tick()
      expect(messages).toEqual([])
      expect(statuses).not.toContainEqual({ kind: 'ready' })
    }, { onMessage: message => messages.push(message) })
  })

  it('discards a MESSAGE_CREATE dispatch whose payload cannot parse', async () => {
    const messages: DiscordInboundMessage[] = []
    await withGateway(async (sockets) => {
      sockets[0]!.frame({ op: DiscordGatewayOpcode.dispatch, t: 'MESSAGE_CREATE', s: 7, d: {} })
      sockets[0]!.frame({ op: DiscordGatewayOpcode.dispatch, t: 'MESSAGE_REACTION_ADD', s: 8, d: {} })
      await tick()
    }, { onMessage: message => messages.push(message) })
    expect(messages).toEqual([])
  })

  it('drops frames that are not JSON, not objects, or carry no opcode', async () => {
    const messages: DiscordInboundMessage[] = []
    await withGateway(async (sockets) => {
      sockets[0]!.emit('message', { data: 'not json' })
      sockets[0]!.emit('message', { data: '[1,2]' })
      sockets[0]!.emit('message', { data: '{"t":"MESSAGE_CREATE"}' })
      sockets[0]!.emit('message', { data: 42 })
      sockets[0]!.emit('message', {})
      await tick()
    }, { onMessage: message => messages.push(message) })
    expect(messages).toEqual([])
  })

  it('reconnects when the gateway asks for it', async () => {
    await withGateway(async (sockets) => {
      sockets[0]!.frame({ op: DiscordGatewayOpcode.reconnect, d: null, s: null, t: null })
      await tick()
      expect(sockets.length).toBeGreaterThan(1)
    })
  })

  it('starts over when the gateway invalidates the session', async () => {
    await withGateway(async (sockets) => {
      sockets[0]!.frame({ op: DiscordGatewayOpcode.invalidSession, d: false, s: null, t: null })
      await tick()
      expect(sockets.length).toBeGreaterThan(1)
    })
  })

  it('treats a socket error as a disconnect', async () => {
    await withGateway(async (sockets) => {
      sockets[0]!.emit('error', new Error('network down'))
      await tick()
      expect(sockets.length).toBeGreaterThan(1)
    })
  })

  it('survives a socket that refuses writes and still reconnects', async () => {
    await withGateway(async (sockets) => {
      sockets[0]!.sendThrows = true
      sockets[0]!.emit('open', undefined)
      await tick()
      sockets[0]!.close()
      await tick()
      expect(sockets.length).toBeGreaterThan(1)
    })
  })

  it('stops retrying once the listener is disposed', async () => {
    const controller = new AbortController()
    let created = 0
    const connecting = connectDiscordGateway({
      token: 'tok',
      socketFactory: () => {
        created += 1
        const socket = new FakeSocket()
        setTimeout(() => { socket.close() }, 0)
        return socket
      },
      onMessage: () => {},
      reconnectDelayMs: 2,
      maxReconnectDelayMs: 2,
    }, controller.signal)
    await tick(6)
    controller.abort(new Error('disposed'))
    const afterAbort = created
    await connecting
    expect(afterAbort).toBeLessThanOrEqual(created)
    expect(created).toBeGreaterThan(1)
  })

  it('drives the platform websocket through the default socket factory', async () => {
    class StubSocket {
      static opened: StubSocket[] = []
      readonly sent: string[] = []
      readonly removed: string[] = []
      private readonly handlers = new Map<string, ((event: unknown) => void)[]>()

      constructor(readonly url: string) {
        StubSocket.opened.push(this)
        setTimeout(() => { this.fire('open', undefined) }, 0)
      }

      send(data: string): void { this.sent.push(data) }
      close(): void { this.fire('close', { code: 1000 }) }
      addEventListener(event: string, handler: (event: unknown) => void): void {
        this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
      }

      removeEventListener(event: string, handler: (event: unknown) => void): void {
        this.removed.push(event)
        this.handlers.set(event, (this.handlers.get(event) ?? []).filter(entry => entry !== handler))
      }

      fire(event: string, payload: unknown): void {
        for (const handler of this.handlers.get(event) ?? []) handler(payload)
      }
    }
    vi.stubGlobal('WebSocket', StubSocket)
    try {
      const controller = new AbortController()
      const connecting = connectDiscordGateway({
        token: 'tok',
        url: 'wss://gateway.test/',
        onMessage: () => {},
      }, controller.signal)
      await tick()
      const socket = StubSocket.opened[0]
      expect(socket?.url).toBe('wss://gateway.test/')
      expect(socket?.sent.find(entry => entry.includes('"op":2'))).toContain('tok')
      socket?.fire('message', { data: JSON.stringify({ op: 1, d: null, s: null, t: null }) })
      controller.abort(new Error('done'))
      await connecting
      expect(socket?.removed).toContain('message')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('discards frames that parse to null or a scalar', async () => {
    const messages: DiscordInboundMessage[] = []
    await withGateway(async (sockets) => {
      sockets[0]!.emit('message', { data: 'null' })
      sockets[0]!.emit('message', { data: '"READY"' })
      await tick()
    }, { onMessage: message => messages.push(message) })
    expect(messages).toEqual([])
  })

  it('ignores a dispatch whose payload is not a message and an unknown opcode', async () => {
    const messages: DiscordInboundMessage[] = []
    await withGateway(async (sockets) => {
      sockets[0]!.frame({ op: DiscordGatewayOpcode.dispatch, t: 'MESSAGE_CREATE', s: 1, d: {} })
      sockets[0]!.frame({ op: 99, d: null, s: null, t: null })
      await tick()
    }, { onMessage: message => messages.push(message) })
    expect(messages).toEqual([])
  })

  it('reports a close that carries no status code', async () => {
    await withGateway(async (_sockets, statuses) => {
      _sockets[0]!.emit('close', {})
      await tick()
      expect(statuses).toContainEqual({ kind: 'disconnected', reason: 'socket closed' })
    })
  })

  it('ends the attempt when the listener is cancelled while the socket opens', async () => {
    const controller = new AbortController()
    const connecting = connectDiscordGateway({
      token: 'tok',
      socketFactory: () => {
        controller.abort(new Error('listener disposed'))
        return new FakeSocket()
      },
      onMessage: () => {},
    }, controller.signal)
    await tick()
    await connecting
    expect(controller.signal.aborted).toBe(true)
  })

  it('stops beating once the connection dies during an interval', async () => {
    const resolvers: (() => void)[] = []
    const controller = new AbortController()
    const socket = new FakeSocket()
    const connecting = connectDiscordGateway({
      token: 'tok',
      socketFactory: () => socket,
      onMessage: () => {},
      wait: (_ms, signal) => new Promise<void>((resolve, reject) => {
        resolvers.push(resolve)
        signal.addEventListener('abort', () => { reject(new Error('wait cancelled')) }, { once: true })
      }),
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    }, controller.signal)
    await tick(2)
    socket.frame({ op: DiscordGatewayOpcode.hello, d: { heartbeat_interval: 1 }, s: null, t: null })
    await tick(2)
    expect(resolvers.length).toBeGreaterThan(0)
    socket.close()
    for (const resolve of resolvers.splice(0)) resolve()
    await tick(2)
    controller.abort(new Error('done'))
    await connecting
  })

  it('gives up the reconnect delay when cancelled with a non-error reason', async () => {
    const controller = new AbortController()
    let created = 0
    const connecting = connectDiscordGateway({
      token: 'tok',
      socketFactory: () => {
        created += 1
        const socket = new FakeSocket()
        setTimeout(() => { socket.close() }, 0)
        return socket
      },
      onMessage: () => {},
      reconnectDelayMs: 50,
      maxReconnectDelayMs: 50,
    }, controller.signal)
    await tick(2)
    controller.abort('gateway outage')
    await connecting
    expect(created).toBeGreaterThanOrEqual(1)
  })

  it('uses the default endpoint and reports a stopped listener', async () => {
    const seen: string[] = []
    const statuses: GatewayStatus[] = []
    const controller = new AbortController()
    const connecting = connectDiscordGateway({
      token: 'tok',
      socketFactory: (url) => {
        seen.push(url)
        return new FakeSocket()
      },
      onMessage: () => {},
      onStatus: status => statuses.push(status),
    }, controller.signal)
    await tick()
    controller.abort(new Error('done'))
    await connecting
    expect(seen).toEqual([DISCORD_GATEWAY_URL])
    expect(statuses[0]).toEqual({ kind: 'connecting' })
    expect(statuses[statuses.length - 1]).toEqual({ kind: 'stopped', reason: 'listener disposed' })
  })

  it('cancels a heartbeat wait that outlives the connection', async () => {
    await withGateway(async (sockets) => {
      sockets[0]!.frame({ op: DiscordGatewayOpcode.hello, d: { heartbeat_interval: 5 }, s: null, t: null })
      await tick()
      sockets[0]!.close()
      await tick()
      expect(sockets.length).toBeGreaterThan(1)
    })
  })

  it('ignores a hello with no interval by beating at the documented fallback', async () => {
    await withGateway(async (sockets) => {
      sockets[0]!.frame({ op: DiscordGatewayOpcode.hello, d: {}, s: null, t: null })
      await tick(3)
      expect(sockets.length).toBe(1)
    })
  })
})
