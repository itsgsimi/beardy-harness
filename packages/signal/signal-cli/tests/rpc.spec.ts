import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { failureText, isPermanent, SignalCliRpc, SignalRpcError, SignalSendError } from '../src/rpc.ts'
import { fakeDaemon } from './support.ts'
import type { FakeDaemon } from './support.ts'

let daemon: FakeDaemon
let rpc: SignalCliRpc
const signal = new AbortController().signal

beforeEach(async () => {
  daemon = await fakeDaemon()
  rpc = new SignalCliRpc({
    rpcUrl: new URL('/api/v1/rpc', daemon.baseUrl), checkUrl: new URL('/api/v1/check', daemon.baseUrl), timeoutMs: 300, fetch: globalThis.fetch,
  })
})

afterEach(async () => { await daemon.close() })

describe('SignalCliRpc.call', () => {
  it('posts a JSON-RPC request and returns its result', async () => {
    daemon.answers.set('version', [{ result: { version: '0.14.8' } }])
    await expect(rpc.call('version', { a: 1 }, signal)).resolves.toEqual({ version: '0.14.8' })
    expect(daemon.calls).toMatchObject([{ jsonrpc: '2.0', method: 'version', params: { a: 1 } }])
    expect(typeof daemon.calls[0]?.id).toBe('string')
  })

  it('classifies JSON-RPC error codes as permanent or retryable', async () => {
    daemon.answers.set('send', [
      { error: { code: -32602, message: 'Invalid params' } },
      { error: { code: -1, message: 'Unregistered user +15551234567' } },
      { error: { code: -5, message: 'Rate limited' } },
      { error: { code: -3, message: 'IO failure' } },
    ])
    const errors: SignalRpcError[] = []
    for (let index = 0; index < 4; index++) {
      errors.push(await rpc.call('send', {}, signal).then(() => { throw new Error('resolved') }, (error: unknown) => error as SignalRpcError))
    }
    expect(errors.map(error => [error.code, error.permanent, isPermanent(error)]))
      .toEqual([[-32602, true, true], [-1, true, true], [-5, false, false], [-3, false, false]])
    expect(failureText(errors[1])).toBe('signal-cli error -1: Unregistered user +*********67')
  })

  it('rejects HTTP failures, invalid JSON, batch-shaped responses, and a mismatched id', async () => {
    daemon.answers.set('x', [
      { status: 500, body: '{}' },
      { status: 200, body: 'not json' },
      { status: 200, body: JSON.stringify([{ jsonrpc: '2.0', id: 1, result: {} }, { jsonrpc: '2.0', id: 2, error: { code: -32600, message: 'bad' } }]) },
      { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 'other', result: {} }) },
      { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: null, result: {}, error: { code: 1, message: 'both' } }) },
    ])
    await expect(rpc.call('x', {}, signal)).rejects.toThrow('signal-cli answered HTTP 500')
    await expect(rpc.call('x', {}, signal)).rejects.toThrow('signal-cli answered with invalid JSON')
    await expect(rpc.call('x', {}, signal)).rejects.toThrow('unexpected JSON-RPC response')
    await expect(rpc.call('x', {}, signal)).rejects.toThrow('unexpected JSON-RPC response')
    await expect(rpc.call('x', {}, signal)).rejects.toThrow('unexpected JSON-RPC response')
  })

  it('accepts an error answered with a null id and times out a hanging daemon', async () => {
    daemon.answers.set('x', [{ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) }, { hang: true }])
    await expect(rpc.call('x', {}, signal)).rejects.toMatchObject({ code: -32700, permanent: true })
    const error = await rpc.call('x', {}, signal).catch((caught: unknown) => caught)
    expect(failureText(error)).toBe('timed out')
    expect(isPermanent(error)).toBe(false)
  })
})

describe('SignalCliRpc.send', () => {
  it('returns the timestamp when a recipient succeeded or no results are listed', async () => {
    daemon.answers.set('send', [
      { result: { timestamp: 5, results: [{ type: 'NETWORK_FAILURE' }, { type: 'SUCCESS' }] } },
      { result: { timestamp: 6 } },
    ])
    await expect(rpc.send({ message: 'a' }, signal)).resolves.toBe(5)
    await expect(rpc.send({ message: 'b' }, signal)).resolves.toBe(6)
  })

  it('fails when no recipient succeeded, permanently only when all are unregistered', async () => {
    daemon.answers.set('send', [
      { result: { timestamp: 5, results: [{ type: 'NETWORK_FAILURE' }, { type: 'RATE_LIMIT_FAILURE' }] } },
      { result: { timestamp: 5, results: [{ type: 'UNREGISTERED_FAILURE' }] } },
      { result: { results: 'nope' } },
    ])
    const transient = await rpc.send({}, signal).catch((error: unknown) => error)
    expect(transient).toBeInstanceOf(SignalSendError)
    expect(failureText(transient)).toBe('signal-cli send reached no recipient (NETWORK_FAILURE, RATE_LIMIT_FAILURE)')
    expect(isPermanent(transient)).toBe(false)
    expect(isPermanent(await rpc.send({}, signal).catch((error: unknown) => error))).toBe(true)
    await expect(rpc.send({}, signal)).rejects.toThrow('signal-cli answered send with an unexpected result')
  })
})

describe('SignalCliRpc.check', () => {
  it('passes on 200 and fails on any other status', async () => {
    await expect(rpc.check(signal)).resolves.toBeUndefined()
    daemon.checkStatus = 503
    await expect(rpc.check(signal)).rejects.toThrow('liveness check answered HTTP 503')
  })
})

describe('failureText', () => {
  it('describes thrown non-errors', () => {
    expect(failureText('plain +15551234567')).toBe('plain +*********67')
    expect(isPermanent('plain')).toBe(false)
  })
})
