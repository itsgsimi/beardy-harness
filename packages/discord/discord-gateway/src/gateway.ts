/**
 * Discord Gateway v10 client: one websocket that identifies with the bot token, keeps itself alive
 * with heartbeats, reports `MESSAGE_CREATE` dispatches upward, and reconnects until its signal is
 * aborted. The socket and the clock are seams, so the protocol is exercised without a network.
 * @module @deepseek-ai/dsh-discord-gateway/gateway
 */

import type { DiscordInboundMessage, GatewayStatus } from './types.ts'

/** Gateway websocket endpoint for API v10 with JSON payloads. A published protocol constant. */
export const DISCORD_GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json'

/** Direct-message channel type, as Discord reports it on a message. */
export const DISCORD_CHANNEL_TYPE_DM = 1

/** Intents the listener needs: guild and direct messages. Both are unprivileged. */
export const DISCORD_GATEWAY_INTENTS = 0x200 | 0x1000

/** Gateway opcodes this client sends or handles. */
export const DiscordGatewayOpcode = {
  dispatch: 0,
  heartbeat: 1,
  identify: 2,
  reconnect: 7,
  invalidSession: 9,
  hello: 10,
  heartbeatAck: 11,
} as const

/** Events of the socket surface this client drives. */
export type GatewaySocketEvent = 'open' | 'message' | 'close' | 'error'

/** The websocket surface this client uses; a test supplies a fake of the same four methods. */
export interface GatewaySocket {
  /** Send one JSON payload. */
  send(data: string): void
  /** Close the connection; the client treats the resulting close event as a disconnect. */
  close(): void
  /** Subscribe to one socket event and get its disposer back. */
  on(event: GatewaySocketEvent, listener: (payload: unknown) => void): () => void
}

/** Create a socket for one gateway URL. */
export type GatewaySocketFactory = (url: string) => GatewaySocket

/** Options of {@link connectDiscordGateway}, including the seams tests replace. */
export interface DiscordGatewayOptions {
  /** Bot token resolved from a credential reference; never logged. */
  readonly token: string
  /** Gateway intents to identify with. */
  readonly intents?: number
  /** Gateway endpoint. Defaults to {@link DISCORD_GATEWAY_URL}. */
  readonly url?: string
  /** Socket constructor seam. Defaults to the platform `WebSocket`. */
  readonly socketFactory?: GatewaySocketFactory
  /** Called for every `MESSAGE_CREATE` dispatch, before any allowlist filtering. */
  readonly onMessage: (message: DiscordInboundMessage) => void
  /** Connection state changes, for logs and diagnostics. */
  readonly onStatus?: (status: GatewayStatus) => void
  /** Delay seam used by heartbeats and reconnect backoff. */
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>
  /** First reconnect delay; each consecutive failure doubles it. Defaults to 1000. */
  readonly reconnectDelayMs?: number
  /** Ceiling for the doubled reconnect delay. Defaults to 30000. */
  readonly maxReconnectDelayMs?: number
}

/** One frame received from the gateway. `d` stays unknown until an opcode handler reads it. */
interface GatewayFrame {
  op: number
  t?: string | null
  s?: number | null
  d?: unknown
}

/** Default socket factory: the platform websocket, narrowed to this client's surface. */
function platformSocket(url: string): GatewaySocket {
  const socket = new WebSocket(url)
  return {
    send: (data) => { socket.send(data) },
    close: () => { socket.close() },
    on: (event, listener) => {
      const handler = (nativeEvent: Event): void => { listener(nativeEvent) }
      socket.addEventListener(event, handler)
      return () => { socket.removeEventListener(event, handler) }
    },
  }
}

/** Read the text payload of a websocket `message` event, whatever form the platform delivered it in. */
function frameData(payload: unknown): string | undefined {
  const data = (payload as { data?: unknown } | undefined)?.data
  if (typeof data === 'string') return data
  return undefined
}

/** Parse one frame, discarding anything that is not a JSON object with a numeric opcode. */
function parseFrame(text: string): GatewayFrame | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const op = record['op']
  const seq = record['s']
  if (typeof op !== 'number') return undefined
  return {
    op,
    t: typeof record['t'] === 'string' ? record['t'] : null,
    s: typeof seq === 'number' ? seq : null,
    d: record['d'],
  }
}

/** Read a string field, using the empty string when it is absent or not a string. */
function textField(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  return typeof value === 'string' ? value : ''
}

/**
 * Reduce one `MESSAGE_CREATE` payload to {@link DiscordInboundMessage}.
 *
 * @param payload - the dispatch's `d` value, server-controlled.
 * @returns the inbound message, or undefined when the payload lacks the identity fields routing needs.
 */
export function parseMessageCreate(payload: unknown): DiscordInboundMessage | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  const author = record['author']
  if (typeof author !== 'object' || author === null) return undefined
  const authorRecord = author as Record<string, unknown>
  const message: DiscordInboundMessage = {
    id: textField(record, 'id'),
    channelId: textField(record, 'channel_id'),
    guildId: textField(record, 'guild_id'),
    authorId: textField(authorRecord, 'id'),
    bot: authorRecord['bot'] === true,
    channelType: typeof record['channel_type'] === 'number' ? record['channel_type'] : 0,
    content: textField(record, 'content'),
  }
  return message.id === '' || message.channelId === '' || message.authorId === '' ? undefined : message
}

/** One live connection and the state its handlers share. */
interface Connection {
  readonly socket: GatewaySocket
  readonly signal: AbortSignal
  readonly disposeListeners: () => void
  seq: number | null
  acked: boolean
  alive: boolean
  settled: boolean
  readonly settle: (reason: string) => void
}

/**
 * Run one connection until it closes, its signal aborts, or a missed heartbeat marks it dead.
 *
 * @param options - token, intents, endpoint, and the reporting callbacks.
 * @param signal - cancellation shared across every reconnect attempt.
 * @param wait - delay seam used for the heartbeat interval.
 * @returns why the connection ended.
 */
async function runConnection(
  options: DiscordGatewayOptions,
  signal: AbortSignal,
  wait: (ms: number, signal: AbortSignal) => Promise<void>,
): Promise<string> {
  const controller = new AbortController()
  const socket = (options.socketFactory ?? platformSocket)(options.url ?? DISCORD_GATEWAY_URL)
  const disposers: (() => void)[] = []
  /* v8 ignore next -- the promise executor below assigns the real resolver before any settle can run. */
  let settleConnection: (reason: string) => void = () => {}
  const settled = new Promise<string>((resolve) => {
    settleConnection = resolve
  })

  const connection: Connection = {
    socket,
    signal: controller.signal,
    disposeListeners: () => {
      for (const dispose of disposers.splice(0)) dispose()
    },
    seq: null,
    acked: true,
    alive: true,
    settled: false,
    settle: (reason: string) => {
      if (connection.settled) return
      connection.settled = true
      connection.alive = false
      settleConnection(reason)
    },
  }

  const send = (payload: Record<string, unknown>): void => {
    try {
      socket.send(JSON.stringify(payload))
    } catch {
      // A socket that refuses a write is already failing; the close event ends the connection.
    }
  }

  disposers.push(socket.on('open', () => {
    send({ op: DiscordGatewayOpcode.identify, d: {
      token: options.token,
      intents: options.intents ?? DISCORD_GATEWAY_INTENTS,
      properties: { os: 'linux', browser: 'dsh', device: 'dsh' },
    } })
  }))

  disposers.push(socket.on('message', (payload) => {
    const text = frameData(payload)
    const frame = text === undefined ? undefined : parseFrame(text)
    if (frame === undefined) return
    if (typeof frame.s === 'number') connection.seq = frame.s
    switch (frame.op) {
      case DiscordGatewayOpcode.hello: {
        const hello = frame.d as { heartbeat_interval?: unknown } | undefined
        const interval = typeof hello?.heartbeat_interval === 'number' ? hello.heartbeat_interval : 41_250
        void heartbeat(connection, interval, send, wait)
        return
      }
      case DiscordGatewayOpcode.heartbeatAck:
        connection.acked = true
        return
      case DiscordGatewayOpcode.dispatch:
        if (frame.t === 'MESSAGE_CREATE') {
          const message = parseMessageCreate(frame.d)
          if (message !== undefined) options.onMessage(message)
        }
        return
      case DiscordGatewayOpcode.reconnect:
        socket.close()
        connection.settle('gateway asked to reconnect')
        return
      case DiscordGatewayOpcode.invalidSession:
        connection.settle('gateway rejected the session')
        return
      default:
        return
    }
  }))

  disposers.push(socket.on('close', (payload) => {
    const code = (payload as { code?: unknown } | undefined)?.code
    connection.settle(typeof code === 'number' ? `socket closed with code ${String(code)}` : 'socket closed')
  }))

  disposers.push(socket.on('error', () => {
    connection.settle('socket error')
  }))

  // Cancellation of the whole listener must end the connection in flight, not only the next one.
  const abortFromParent = (): void => {
    controller.abort(signal.reason)
    try {
      socket.close()
    } catch {
      // A socket that refuses to close is already gone; the settle below ends the attempt.
    }
    connection.settle('cancelled')
  }
  if (signal.aborted) abortFromParent()
  else signal.addEventListener('abort', abortFromParent, { once: true })

  const reason = await settled
  signal.removeEventListener('abort', abortFromParent)
  connection.alive = false
  connection.disposeListeners()
  controller.abort(new Error('discord gateway connection ended'))
  return signal.aborted ? 'cancelled' : reason
}

/** Beat the connection until it dies, closing it when the server stops answering. */
async function heartbeat(
  connection: Connection,
  intervalMs: number,
  send: (payload: Record<string, unknown>) => void,
  wait: (ms: number, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  while (connection.alive && !connection.signal.aborted) {
    try {
      await wait(intervalMs, connection.signal)
    } catch {
      return
    }
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- the socket can close while the interval is awaited.
    if (!connection.alive) return
    if (!connection.acked) {
      connection.socket.close()
      connection.settle('gateway missed the heartbeat acknowledgement')
      return
    }
    connection.acked = false
    send({ op: DiscordGatewayOpcode.heartbeat, d: connection.seq })
  }
}

/**
 * Connect to the Discord Gateway and keep reconnecting until `signal` aborts.
 *
 * Every close is followed by a doubled delay, capped at `maxReconnectDelayMs`, so a gateway outage
 * costs one reconnect attempt per interval rather than a busy loop. The returned promise resolves
 * when the signal aborts; it never rejects, because a listener failure must not surface as an
 * unhandled rejection in the host that mounted it.
 *
 * @param options - token, callbacks, and seams.
 * @param signal - cancellation for the whole listener, not one connection.
 * @returns when the listener has stopped.
 */
export async function connectDiscordGateway(
  options: DiscordGatewayOptions,
  signal: AbortSignal,
): Promise<void> {
  const wait = options.wait ?? abortableWait
  const baseDelay = options.reconnectDelayMs ?? 1_000
  const maxDelay = options.maxReconnectDelayMs ?? 30_000
  const report = options.onStatus ?? (() => {})
  let attempt = 0

  while (!signal.aborted) {
    report({ kind: 'connecting' })
    const reason = await runConnection(options, signal, wait)
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- the listener can be disposed while a connection is open.
    if (signal.aborted) break
    attempt += 1
    report({ kind: 'disconnected', reason })
    const delay = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay)
    try {
      await wait(delay, signal)
    } catch {
      break
    }
  }
  report({ kind: 'stopped', reason: 'listener disposed' })
}

/** Wait out a delay, rejecting as soon as the signal aborts. */
async function abortableWait(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
