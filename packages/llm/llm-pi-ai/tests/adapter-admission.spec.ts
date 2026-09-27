import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await closeMockServers()
})

async function harness(url: string, streamIdleTimeoutMs = 1_000, queueTimeoutMs = 1_000): Promise<Context> {
  vi.stubEnv('PI_ADMISSION_TEST_KEY', 'test-key')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, {
    providers: {
      deepseek: {
        apiKeyEnv: 'PI_ADMISSION_TEST_KEY',
        baseURL: url,
        maxConcurrentRequests: 1,
        queueTimeoutMs,
        streamIdleTimeoutMs,
      },
    },
  })
  return ctx
}

const request = { model: 'deepseek-v4-flash', messages: [] }

describe('pi-ai provider admission lifecycle', () => {
  it('releases the slot after success and a terminal provider error', async () => {
    const server = await mockServer([
      { events: textEvents },
      { status: 503, body: JSON.stringify({ error: { message: 'provider unavailable' } }) },
      { events: textEvents },
    ])
    const ctx = await harness(server.url)
    expect((await assemble(ctx, request)).finish.kind).toBe('stop')
    expect((await assemble(ctx, request)).finish.kind).toBe('error')
    expect((await assemble(ctx, request)).finish.kind).toBe('stop')
    expect(server.requests).toHaveLength(3)
  })

  it('releases the slot after a pre-dispatch request error', async () => {
    const server = await mockServer([{ events: textEvents }])
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ deepseek: {
        baseURL: server.url,
        maxConcurrentRequests: 1,
        queueTimeoutMs: 1_000,
      } }),
      resolveApiKey: () => Promise.resolve('test-key'),
      auth: memoryAuth(),
    })
    const image: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
    }
    const failed = async (): Promise<void> => {
      for await (const _chunk of adapter.stream({
        provider: 'deepseek',
        ...request,
        messages: [createUserMessage({
          content: [{ type: 'image', attachment: image }],
          source: { kind: 'test' },
        })],
      })) { /* drain */ }
    }
    await expect(failed()).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    const chunks = []
    for await (const chunk of adapter.stream({ provider: 'deepseek', ...request })) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(server.requests).toHaveLength(1)
  })

  it('releases the slot after a caller abort during streaming', async () => {
    const server = await mockServer([
      { events: textEvents, delayMs: 200 },
      { events: textEvents },
    ])
    const ctx = await harness(server.url)
    const controller = new AbortController()
    const first = assemble(ctx, { ...request, signal: controller.signal })
    await vi.waitFor(() => { expect(server.requests).toHaveLength(1) })
    const next = assemble(ctx, request)
    controller.abort('cancel first')
    expect((await first).finish.kind).toBe('aborted')
    expect((await next).finish.kind).toBe('stop')
    expect(server.requests).toHaveLength(2)
  })

  it('releases the slot after the stream idle watchdog expires', async () => {
    const server = await mockServer([
      { events: textEvents, delayMs: 200 },
      { events: textEvents },
    ])
    const ctx = await harness(server.url, 30)
    const first = assemble(ctx, request)
    await vi.waitFor(() => { expect(server.requests).toHaveLength(1) })
    const next = assemble(ctx, request)
    expect((await first).finish).toMatchObject({ kind: 'error', failure: { code: 'TIMEOUT' } })
    expect((await next).finish.kind).toBe('stop')
    expect(server.requests).toHaveLength(2)
  })

  it('releases the slot when the consumer closes a stream early', async () => {
    const server = await mockServer([
      { events: textEvents },
      { events: textEvents },
    ])
    const ctx = await harness(server.url)
    const first = ctx.llm.stream({ provider: 'deepseek', ...request })[Symbol.asyncIterator]()
    expect((await first.next()).done).toBe(false)
    const next = assemble(ctx, request)
    await first.return?.()
    expect((await next).finish.kind).toBe('stop')
    expect(server.requests).toHaveLength(2)
  })

  it('reports a queued timeout as a distinct terminal finish through the LLM service', async () => {
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    const ctx = await harness(server.url, 1_000, 40)
    const first = ctx.llm.stream({ provider: 'deepseek', ...request })[Symbol.asyncIterator]()
    expect((await first.next()).done).toBe(false)
    const timedOut = await assemble(ctx, request)
    expect(timedOut.finish).toMatchObject({ kind: 'error', failure: { code: 'ADMISSION_TIMEOUT' } })
    expect(server.requests).toHaveLength(1)
    await first.return?.()
    expect((await assemble(ctx, request)).finish.kind).toBe('stop')
  })

  it('surfaces queued abort and queue timeout without dispatching those requests', async () => {
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    const secondKeyResolved = Promise.withResolvers<undefined>()
    let keys = 0
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ deepseek: {
        baseURL: server.url,
        maxConcurrentRequests: 1,
        queueTimeoutMs: 40,
        streamIdleTimeoutMs: 1_000,
      } }),
      resolveApiKey: () => {
        keys += 1
        if (keys === 2) secondKeyResolved.resolve(undefined)
        return Promise.resolve('test-key')
      },
      auth: memoryAuth(),
    })
    const drain = async (signal?: AbortSignal): Promise<void> => {
      for await (const _chunk of adapter.stream({
        provider: 'deepseek', ...request, ...signal === undefined ? {} : { signal },
      })) { /* drain */ }
    }
    const first = adapter.stream({ provider: 'deepseek', ...request })[Symbol.asyncIterator]()
    expect((await first.next()).done).toBe(false)

    const controller = new AbortController()
    const aborted = expect(drain(controller.signal)).rejects.toMatchObject({ code: 'ABORTED' })
    await secondKeyResolved.promise
    await Promise.resolve()
    controller.abort()
    await aborted
    const timedOut = expect(drain()).rejects.toMatchObject({ code: 'ADMISSION_TIMEOUT' })
    await timedOut
    expect(server.requests).toHaveLength(1)

    await first.return?.()
    await drain()
    expect(server.requests).toHaveLength(2)
  })

  it('does not charge queued time to the stream idle watchdog', async () => {
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    const secondKeyResolved = Promise.withResolvers<undefined>()
    let keys = 0
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ deepseek: {
        baseURL: server.url,
        maxConcurrentRequests: 1,
        queueTimeoutMs: 5_000,
        streamIdleTimeoutMs: 500,
      } }),
      resolveApiKey: () => {
        keys += 1
        if (keys === 2) secondKeyResolved.resolve(undefined)
        return Promise.resolve('test-key')
      },
      auth: memoryAuth(),
    })
    const first = adapter.stream({ provider: 'deepseek', ...request })[Symbol.asyncIterator]()
    expect((await first.next()).done).toBe(false)

    vi.useFakeTimers()
    const second = (async () => {
      const chunks = []
      for await (const chunk of adapter.stream({ provider: 'deepseek', ...request })) chunks.push(chunk)
      return chunks
    })()
    const settled = vi.fn()
    void second.then(settled, settled)
    await secondKeyResolved.promise
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(settled).not.toHaveBeenCalled()
    vi.useRealTimers()

    await first.return?.()
    const chunks = await second
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(server.requests).toHaveLength(2)
  })
})
