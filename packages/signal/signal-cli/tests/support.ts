/** A fake signal-cli HTTP daemon on an ephemeral loopback port. No real network is used. */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** One JSON-RPC request the fake daemon received. */
export interface RpcCall {
  readonly id: unknown
  readonly method: string
  readonly params: Record<string, unknown>
}

/** How the fake answers one RPC call: a JSON-RPC result, an error, or a raw HTTP reply. */
export type RpcAnswer =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string } }
  | { readonly status: number; readonly body: string }
  | { readonly hang: true }

/** Running fake daemon. */
export interface FakeDaemon {
  readonly baseUrl: string
  readonly calls: RpcCall[]
  /** Next answers per method; an empty queue answers `send` with success and `listAccounts` with one account. */
  readonly answers: Map<string, RpcAnswer[]>
  /** Status the liveness endpoint answers. */
  checkStatus: number
  /** Statuses the next event-stream connections answer before streaming. */
  readonly eventStatuses: number[]
  /** Event-stream connections opened so far. */
  eventConnections: number
  /** Write one SSE event with raw data to every open stream. */
  push(data: string): void
  /** Resolve once an event stream is open. */
  streamOpen(): Promise<void>
  /** End every open event stream. */
  endStreams(): void
  close(): Promise<void>
}

/** Account the fake daemon reports. */
export const ACCOUNT = '+15550001234'

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => { resolve(body) })
  })
}

/**
 * Start a fake daemon.
 * @returns running daemon; close it after the test.
 */
export async function fakeDaemon(): Promise<FakeDaemon> {
  const streams = new Set<ServerResponse>()
  const hanging = new Set<ServerResponse>()
  let opened = Promise.withResolvers<undefined>()
  const daemon: Omit<FakeDaemon, 'baseUrl' | 'close'> = {
    calls: [],
    answers: new Map(),
    checkStatus: 200,
    eventStatuses: [],
    eventConnections: 0,
    push(data) { for (const stream of streams) stream.write(`data: ${data}\n\n`) },
    streamOpen: () => opened.promise,
    endStreams() {
      for (const stream of streams) stream.end()
      streams.clear()
    },
  }
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === '/api/v1/check') {
        response.writeHead(daemon.checkStatus).end()
        return
      }
      if (request.url === '/api/v1/events') {
        daemon.eventConnections++
        const status = daemon.eventStatuses.shift()
        if (status !== undefined) {
          response.writeHead(status).end('unavailable')
          return
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(': connected\n\n')
        streams.add(response)
        response.on('close', () => { streams.delete(response) })
        opened.resolve(undefined)
        opened = Promise.withResolvers<undefined>()
        return
      }
      const request_ = JSON.parse(await readBody(request)) as RpcCall
      daemon.calls.push(request_)
      const answer = daemon.answers.get(request_.method)?.shift()
        ?? (request_.method === 'listAccounts' ? { result: [{ number: ACCOUNT }] } : { result: { timestamp: 1_700_000_000_000, results: [{ type: 'SUCCESS' }] } })
      if ('hang' in answer) {
        hanging.add(response)
        return
      }
      if ('status' in answer) {
        response.writeHead(answer.status, { 'content-type': 'application/json' }).end(answer.body)
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: request_.id, ...answer }))
    })()
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return Object.assign(daemon, {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    async close() {
      daemon.endStreams()
      for (const response of hanging) response.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  })
}

/**
 * Wait until a condition holds.
 * @param condition - polled every 5 ms.
 * @param timeoutMs - failure deadline.
 */
export async function until(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
