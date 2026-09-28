/**
 * JSON-RPC 2.0 over the signal-cli daemon's HTTP endpoint, the liveness check, and the `send` and
 * `listAccounts` results this provider reads. Every response is validated at this process boundary.
 * @module @deepseek-ai/dsh-signal-cli/rpc
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'

/**
 * JSON-RPC error codes that repeat for the same request: malformed JSON, an invalid request, an
 * unknown method, invalid parameters, and signal-cli's user error (-1), which covers an unknown
 * group, a group the account left, and an unregistered recipient. Every other code, including
 * rate limits, I/O failures, and untrusted identities, is retried.
 */
export const PERMANENT_RPC_CODES: ReadonlySet<number> = new Set([-32700, -32600, -32601, -32602, -1])

/**
 * Mask every digit of a phone number but the last two, for logs and status.
 * @param number - E.164 number.
 * @returns `+` followed by asterisks and the last two digits, such as `+*********67`.
 */
export function maskNumber(number: string): string {
  const digits = number.replace(/^\+/u, '')
  return `+${'*'.repeat(Math.max(0, digits.length - 2))}${digits.slice(-2)}`
}

/** A JSON-RPC error object returned by the daemon. */
export class SignalRpcError extends Error {
  override readonly name = 'SignalRpcError'
  /**
   * @param code - JSON-RPC error code.
   * @param message - daemon-supplied message.
   * @param permanent - whether repeating the same request cannot succeed.
   */
  constructor(readonly code: number, message: string, readonly permanent: boolean) {
    super(`signal-cli error ${String(code)}: ${message}`)
  }
}

/** A send the daemon accepted but that reached no recipient. */
export class SignalSendError extends Error {
  override readonly name = 'SignalSendError'
  /**
   * @param types - per-recipient result types.
   * @param permanent - whether every recipient failed permanently.
   */
  constructor(readonly types: readonly string[], readonly permanent: boolean) {
    super(`signal-cli send reached no recipient (${types.join(', ')})`)
  }
}

const rpcError = z.object({ code: z.number().int(), message: z.string() })

/** One JSON-RPC response object; `result` and `error` are mutually exclusive. */
const rpcResponse = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]),
  result: z.unknown().optional(),
  error: rpcError.optional(),
}).refine(response => (response.error === undefined) !== (response.result === undefined), 'exactly one of result and error')

/** Result types of `SendMessageResult.type` in signal-cli's published schema. */
const sendResultType = z.enum(['SUCCESS', 'NETWORK_FAILURE', 'UNREGISTERED_FAILURE', 'IDENTITY_FAILURE', 'RATE_LIMIT_FAILURE', 'INVALID_PRE_KEY_FAILURE'])

/** The `send` result: the message timestamp and one result per recipient. */
export const sendResponse = z.object({
  timestamp: z.number().int(),
  results: z.array(z.object({ type: sendResultType })).default([]),
})

/** The `listAccounts` result of a multi-account daemon. */
export const accountsResponse = z.array(z.object({ number: z.string() }))

/** Transport settings for one daemon. */
export interface RpcOptions {
  readonly rpcUrl: URL
  readonly checkUrl: URL
  readonly timeoutMs: number
  readonly fetch: typeof globalThis.fetch
}

/** HTTP JSON-RPC client for one signal-cli daemon. */
export class SignalCliRpc {
  /** @param options - endpoints, request timeout, and fetch implementation. */
  constructor(private readonly options: RpcOptions) {}

  /**
   * Call one method and return its validated result envelope.
   * @param method - JSON-RPC method name.
   * @param params - named parameters.
   * @param signal - cancels the request.
   * @returns the `result` value, still unvalidated beyond JSON-RPC framing.
   * @throws SignalRpcError for a JSON-RPC error; Error for HTTP, framing, timeout, or network failures.
   */
  async call(method: string, params: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown> {
    const id = randomUUID()
    const response = await this.options.fetch(this.options.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs)]),
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`signal-cli answered HTTP ${String(response.status)}`)
    let json: unknown
    try {
      json = JSON.parse(body)
    } catch {
      // The parser's SyntaxError names an offset in a body that is never logged.
      throw new Error('signal-cli answered with invalid JSON')
    }
    const parsed = rpcResponse.safeParse(json)
    if (!parsed.success || (parsed.data.id !== id && parsed.data.id !== null)) throw new Error('signal-cli answered with an unexpected JSON-RPC response')
    const { error } = parsed.data
    if (error !== undefined) throw new SignalRpcError(error.code, error.message, PERMANENT_RPC_CODES.has(error.code))
    return parsed.data.result
  }

  /**
   * Send one message and require that it reached at least one recipient.
   * @param params - `send` parameters.
   * @param signal - cancels the request.
   * @returns the message timestamp.
   * @throws SignalSendError when every recipient failed; errors of {@link call} otherwise.
   */
  async send(params: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<number> {
    const parsed = sendResponse.safeParse(await this.call('send', params, signal))
    if (!parsed.success) throw new Error('signal-cli answered send with an unexpected result')
    const types = parsed.data.results.map(result => result.type)
    if (types.length > 0 && !types.includes('SUCCESS')) {
      throw new SignalSendError(types, types.every(type => type === 'UNREGISTERED_FAILURE'))
    }
    return parsed.data.timestamp
  }

  /**
   * Check the daemon's liveness endpoint.
   * @param signal - cancels the request.
   * @throws Error when the daemon does not answer 200 in time.
   */
  async check(signal: AbortSignal): Promise<void> {
    const response = await this.options.fetch(this.options.checkUrl, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs)]),
    })
    await response.arrayBuffer()
    if (response.status !== 200) throw new Error(`liveness check answered HTTP ${String(response.status)}`)
  }
}

/**
 * Describe a failure without request bodies or message text, masking any phone number a daemon
 * error message quotes.
 * @param error - thrown value.
 * @returns a short cause.
 */
export function failureText(error: unknown): string {
  const text = error instanceof Error ? error.name === 'TimeoutError' ? 'timed out' : error.message : String(error)
  return text.replace(/\+\d{7,15}/gu, maskNumber)
}

/**
 * Whether repeating the failed request cannot succeed.
 * @param error - thrown value.
 * @returns true for permanent JSON-RPC errors and sends every recipient refused permanently.
 */
export function isPermanent(error: unknown): boolean {
  return (error instanceof SignalRpcError || error instanceof SignalSendError) && error.permanent
}
