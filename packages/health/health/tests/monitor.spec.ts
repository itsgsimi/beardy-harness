import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { HealthMonitor, apply, assertConfig } from '../src/index.ts'
import type { HealthMonitorDeps, HealthStatus, ResolvedConfig } from '../src/index.ts'

const monitors: HealthMonitor[] = []
afterEach(async () => { await Promise.all(monitors.splice(0).map(monitor => monitor.dispose())) })

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return { probes: [{ name: 'main', url: 'http://127.0.0.1/models', expectedStatus: 200 }],
    intervalMs: 1_000, timeoutMs: 100, failureThreshold: 2, recoveryThreshold: 2,
    noticeChannelId: '1472404859679670455', noticeCooldownMs: 900_000, ...overrides }
}

function fixture(statuses: number[], overrides: Partial<ResolvedConfig> = {}, credentials?: string, noChannel = false) {
  const notices: { id: string; channelId: string; text: string }[] = []
  let now = 0
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const status = statuses.shift()
    if (status === undefined) throw new Error('connection refused')
    if (credentials !== undefined) expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${credentials}`)
    return new Response('', { status })
  })
  const deps: HealthMonitorDeps = {
    fetch: fetcher,
    resolveCredential: async () => credentials,
    deliver: async (notice) => { notices.push(notice); return true },
    now: () => now,
  }
  const configured = config(overrides)
  const { noticeChannelId: _channel, ...withoutChannel } = configured
  const monitor = new HealthMonitor(noChannel ? withoutChannel : configured, deps)
  monitors.push(monitor)
  return { monitor, notices, fetcher, advance: (ms: number) => { now += ms } }
}

describe('configured endpoint health', () => {
  it('pauses an intentionally unloaded endpoint without a down notice or HTTP request', async () => {
    let paused = false
    const notices: string[] = []
    const fetcher = vi.fn(async () => new Response('', { status: 503 }))
    const monitor = new HealthMonitor(config({ failureThreshold: 1 }), {
      fetch: fetcher, resolveCredential: async () => undefined, now: () => 1,
      deliver: async (transition) => { notices.push(transition.text); return true },
      paused: () => paused ? { intent: { by: 'Goran', at: '2026-09-27T18:00:00.000Z' } } : undefined,
    })
    monitors.push(monitor)
    paused = true
    expect(monitor.snapshot().probes[0]).toMatchObject({ state: 'paused', pausedBy: 'Goran',
      pausedAt: '2026-09-27T18:00:00.000Z' })
    await monitor.check()
    expect(fetcher).not.toHaveBeenCalled()
    expect(notices).toEqual([])
    paused = false
    await monitor.check()
    expect(monitor.snapshot().probes[0]?.state).toBe('down')
    expect(notices).toEqual(['Probe main: down (HTTP 503).'])
    paused = true
    await monitor.check()
    expect(monitor.snapshot().probes[0]?.state).toBe('paused')
    expect(notices).toHaveLength(1)
  })

  it('suppresses a down transition when unload arrives during an HTTP check', async () => {
    let paused = false
    const entered = Promise.withResolvers<undefined>()
    const response = Promise.withResolvers<Response>()
    const notices: string[] = []
    const monitor = new HealthMonitor(config({ failureThreshold: 1 }), {
      fetch: async () => { entered.resolve(undefined); return await response.promise },
      resolveCredential: async () => undefined, now: () => 1,
      deliver: async (transition) => { notices.push(transition.text); return true },
      paused: () => paused ? { intent: { by: 'Goran', at: '2026-09-27T18:00:00.000Z' } } : undefined,
    })
    monitors.push(monitor)
    const checking = monitor.check()
    await entered.promise
    paused = true
    response.resolve(new Response('', { status: 503 }))
    await checking
    expect(monitor.snapshot().probes[0]?.state).toBe('paused')
    expect(notices).toEqual([])
  })

  it('goes down only after its failure threshold and recovers after its recovery threshold', async () => {
    const h = fixture([503, 503, 503, 200, 200, 200])
    await h.monitor.check()
    expect(h.monitor.snapshot().probes[0]?.state).toBe('unknown')
    await h.monitor.check()
    expect(h.monitor.snapshot().probes[0]).toMatchObject({ state: 'down', cause: 'HTTP 503' })
    await h.monitor.check()
    await h.monitor.check()
    expect(h.monitor.snapshot().probes[0]?.state).toBe('down')
    await h.monitor.check()
    await h.monitor.check()
    expect(h.monitor.snapshot().probes[0]).toMatchObject({ state: 'healthy' })
    expect(h.notices.map(notice => notice.text)).toEqual(['Probe main: down (HTTP 503).', 'Probe main: recovered.'])
    expect(new Set(h.notices.map(notice => notice.id)).size).toBe(2)
  })

  it('does not announce an initially healthy target and suppresses repeated down notices within cooldown', async () => {
    const h = fixture([200, 200, 503, 503, 200, 200, 503, 503, 200, 200, 503, 503, 200, 200, 503, 503])
    for (let index = 0; index < 12; index++) { await h.monitor.check(); h.advance(1) }
    expect(h.notices.map(notice => notice.text)).toEqual(['Probe main: down (HTTP 503).', 'Probe main: recovered.'])
    h.advance(900_000)
    for (let index = 0; index < 4; index++) await h.monitor.check()
    expect(h.notices.map(notice => notice.text)).toEqual([
      'Probe main: down (HTTP 503).', 'Probe main: recovered.', 'Probe main: recovered.', 'Probe main: down (HTTP 503).',
    ])
  })

  it('retries one stable transition identity when outbox acceptance fails', async () => {
    const h = fixture([503, 503, 503], { failureThreshold: 1 })
    const ids: string[] = []
    let accepted = false
    const monitor = new HealthMonitor(config({ failureThreshold: 1 }), {
      fetch: h.fetcher, resolveCredential: async () => undefined, now: () => 1,
      deliver: async (transition) => { ids.push(transition.id); return accepted },
    })
    monitors.push(monitor)
    await monitor.check()
    await monitor.check()
    accepted = true
    await monitor.check()
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(1)
    expect(monitor.snapshot().probes[0]?.state).toBe('down')
  })

  it('continues observing recovery while the gateway holds two pending transitions', async () => {
    const h = fixture([503, 200, 503, 200, 200], { failureThreshold: 1, recoveryThreshold: 1 })
    const attempts: string[] = []
    const accepted: string[] = []
    let ready = false
    const monitor = new HealthMonitor(config({ failureThreshold: 1, recoveryThreshold: 1 }), {
      fetch: h.fetcher, resolveCredential: async () => undefined, now: () => 1,
      deliver: async (transition) => {
        attempts.push(transition.id)
        if (!ready) return false
        accepted.push(transition.text)
        return true
      },
    })
    monitors.push(monitor)
    await monitor.check()
    expect(monitor.snapshot().probes[0]?.state).toBe('down')
    await monitor.check()
    expect(monitor.snapshot().probes[0]?.state).toBe('healthy')
    await monitor.check()
    await monitor.check()
    expect(monitor.snapshot().probes[0]?.state).toBe('healthy')
    ready = true
    await monitor.check()
    expect(accepted).toEqual(['Probe main: down (HTTP 503).', 'Probe main: recovered.'])
    expect(attempts.slice(0, 5)).toEqual([attempts[0], attempts[0], attempts[0], attempts[0], attempts[0]])
    expect(new Set(attempts).size).toBe(2)
  })

  it('counts an authenticated HTTP rejection without disclosing the credential', async () => {
    const h = fixture([401], { probes: [{ name: 'main', url: 'http://127.0.0.1/models',
      expectedStatus: 200, credentialRef: 'MODEL_TOKEN' }], failureThreshold: 1 }, 'private-token')
    await h.monitor.check()
    expect(h.notices[0]?.text).toBe('Probe main: down (HTTP 401).')
    expect(JSON.stringify(h.monitor.snapshot())).not.toContain('private-token')
  })

  it('reports a missing credential and a connection error as probe failures', async () => {
    const h = fixture([], { probes: [{ name: 'main', url: 'http://127.0.0.1/models', credentialRef: 'MISSING' }],
      failureThreshold: 1 })
    await h.monitor.check()
    expect(h.monitor.snapshot().probes[0]?.cause).toBe('credential unavailable')
    const disconnected = fixture([], { failureThreshold: 1 })
    await disconnected.monitor.check()
    expect(disconnected.monitor.snapshot().probes[0]?.cause).toBe('connection failed or timed out')
  })

  it('keeps only the last failed cron fact', () => {
    const h = fixture([])
    h.monitor.recordCronFailure({ jobName: 'brief', sessionId: 's1', firedAt: 1,
      outcome: 'failed', text: '', reportOutcome: true, failure: { code: 'TRANSPORT', message: 'private' },
      nextFireAt: '2026-09-28T07:00:00.000Z' })
    h.monitor.recordCronFailure({ jobName: 'ignored', sessionId: 's2', firedAt: 2,
      outcome: 'answered', text: 'ok', reportOutcome: true })
    expect(h.monitor.snapshot().lastCronFailure).toEqual({ jobName: 'brief', sessionId: 's1',
      code: 'TRANSPORT', nextFireAt: '2026-09-28T07:00:00.000Z' })
    h.monitor.recordCronFailure({ jobName: 'brief', sessionId: 's3', firedAt: 3,
      outcome: 'timed-out', text: '', reportOutcome: true })
    expect(h.monitor.snapshot().lastCronFailure).toEqual({ jobName: 'brief', sessionId: 's3', code: 'TIMED-OUT' })
    h.monitor.recordCronFailure({ jobName: 'brief', sessionId: 's4', firedAt: 4,
      outcome: 'failed', text: '', reportOutcome: true, failure: { code: 'secret: abc', message: 'private' } })
    expect(h.monitor.snapshot().lastCronFailure).toEqual({ jobName: 'brief', sessionId: 's4', code: 'FAILED' })
  })

  it('keeps status without notices when no channel is configured', async () => {
    const h = fixture([503], { failureThreshold: 1 }, undefined, true)
    await h.monitor.check()
    expect(h.monitor.snapshot().probes[0]?.state).toBe('down')
    expect(h.notices).toEqual([])
    await h.monitor.dispose()
    await h.monitor.check()
    expect(h.fetcher).toHaveBeenCalledTimes(1)
  })

  it('shares an active poll and aborts a pending HTTP request on disposal', async () => {
    const entered = Promise.withResolvers<undefined>()
    const cancelled = Promise.withResolvers<undefined>()
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      entered.resolve(undefined)
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { cancelled.resolve(undefined); reject(new Error('aborted')) }, { once: true })
      })
    })
    const monitor = new HealthMonitor(config({ probes: [
      { name: 'main', url: 'http://127.0.0.1/main' },
      { name: 'secondary', url: 'http://127.0.0.1/secondary' },
    ] }), { fetch: fetcher,
      resolveCredential: async () => undefined, deliver: async () => true, now: Date.now })
    monitors.push(monitor)
    const first = monitor.check()
    const second = monitor.check()
    expect(second).toBe(first)
    await entered.promise
    await monitor.dispose()
    await cancelled.promise
    await first
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not schedule another poll when disposal interrupts the current request', async () => {
    const entered = Promise.withResolvers<undefined>()
    const server = createServer((_request, response) => {
      entered.resolve(undefined)
      response.on('close', () => { response.end() })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture port missing')
    let disposeEffect: (() => void | Promise<void>) | undefined
    const ctx = {
      credentials: { resolve: async () => undefined },
      serial: async () => true,
      provide: () => {},
      get: () => undefined,
      on: () => () => {},
      effect: (mount: () => () => void | Promise<void>) => { disposeEffect = mount() },
      logger: { warn: () => {} },
    } as never as Context
    try {
      apply(ctx, config({ probes: [{ name: 'main', url: `http://127.0.0.1:${String(address.port)}/models` }],
        intervalMs: 1, timeoutMs: 10_000 }))
      await entered.promise
      await disposeEffect?.()
    } finally {
      await disposeEffect?.()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => { if (error === undefined) resolve(); else reject(error) }))
    }
  })

  it('reports an unexpected polling failure and still disposes its timer', async () => {
    for (const scenario of [{ thrown: new Error('clock unavailable'), kind: 'Error' },
      { thrown: 'clock unavailable', kind: 'error' }]) {
      const warned = Promise.withResolvers<string>()
      let disposeEffect: (() => void | Promise<void>) | undefined
      const ctx = {
        credentials: { resolve: async () => undefined },
        serial: async () => true,
        provide: () => {},
        get: () => undefined,
        on: () => () => {},
        effect: (mount: () => () => void | Promise<void>) => { disposeEffect = mount() },
        logger: { warn: (line: string) => { warned.resolve(line) } },
      } as never as Context
      const clock = vi.spyOn(Date, 'now').mockImplementationOnce(() => { throw scenario.thrown })
      try {
        apply(ctx, config({ probes: [{ name: 'main', url: 'http://127.0.0.1/models', credentialRef: 'MISSING' }] }))
        await expect(warned.promise).resolves.toBe(`health: probe poll failed: ${scenario.kind}`)
      } finally {
        clock.mockRestore()
        await disposeEffect?.()
      }
    }
  })

  it('mounts a credentialed probe and retries the same gateway transition after acceptance errors', async () => {
    const server = createServer((request, response) => {
      expect(request.headers.authorization).toBe('Bearer fixture-token')
      response.writeHead(503)
      response.end()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture port missing')
    const ids: string[] = []
    const warnings: string[] = []
    let status: HealthStatus | undefined
    let disposeEffect: (() => void | Promise<void>) | undefined
    const ctx = {
      credentials: { resolve: async () => ({ value: 'fixture-token' }) },
      serial: async (_event: string, transition: { id: string }) => {
        ids.push(transition.id)
        if (ids.length === 1) throw new Error('outbox not ready')
        if (ids.length === 2) throw 'outbox closed'
        return true
      },
      provide: (_name: string, value: HealthStatus) => { status = value },
      get: () => undefined,
      on: () => () => {},
      effect: (mount: () => () => void | Promise<void>) => { disposeEffect = mount() },
      logger: { warn: (line: string) => { warnings.push(line) } },
    } as never as Context
    try {
      apply(ctx, config({ probes: [{ name: 'main', url: `http://127.0.0.1:${String(address.port)}/models`,
        credentialRef: 'FIXTURE_TOKEN' }], intervalMs: 1, failureThreshold: 1 }))
      await vi.waitFor(() => { expect(ids.length).toBeGreaterThanOrEqual(3) })
      expect(new Set(ids).size).toBe(1)
      expect(warnings).toEqual(expect.arrayContaining([
        'health: probe notice could not enter the gateway outbox: Error',
        'health: probe notice could not enter the gateway outbox: error',
      ]))
      expect(status?.snapshot().probes[0]?.state).toBe('down')
    } finally {
      await disposeEffect?.()
      await new Promise<void>((resolve, reject) => server.close((error) => { if (error === undefined) resolve(); else reject(error) }))
    }
  })

  it('validates names, URLs, statuses, and integer bounds at load', () => {
    expect(() => { assertConfig(config({ probes: [{ name: 'x', url: 'http://a' }, { name: 'x', url: 'http://b' }] })) }).toThrow(/name/)
    expect(() => { assertConfig(config({ probes: [{ name: 'x', url: 'file:///tmp/a' }] })) }).toThrow(/HTTP URL/)
    expect(() => { assertConfig(config({ probes: [{ name: 'x', url: 'http://user:pass@example.test/' }] })) }).toThrow(/HTTP URL/)
    expect(() => { assertConfig(config({ probes: [{ name: 'x', url: 'oops' }] })) }).toThrow(/invalid URL/)
    expect(() => { assertConfig(config({ probes: [{ name: 'x', url: 'http://a', expectedStatus: 999 }] })) }).toThrow(/expectedStatus/)
    expect(() => { assertConfig(config({ intervalMs: 1.5 })) }).toThrow(/intervalMs/)
    expect(() => { assertConfig(config({ intervalMs: 2_147_483_648 })) }).toThrow(/timer range/)
    expect(() => { assertConfig(config({ timeoutMs: 2_147_483_648 })) }).toThrow(/timer range/)
    expect(() => { assertConfig(config({ noticeCooldownMs: -1 })) }).toThrow(/noticeCooldownMs/)
    expect(() => { assertConfig(config({ noticeChannelId: '' })) }).toThrow(/health: noticeChannelId must be a Discord channel id .*signal:number:/)
    for (const target of ['signal:number:+15551234567', `signal:group:${Buffer.alloc(32, 9).toString('base64')}`, 'discord:1472404859679670455']) {
      expect(() => { assertConfig(config({ noticeChannelId: target })) }).not.toThrow()
    }
    expect(() => { assertConfig(config({ probes: [{ name: '', url: 'http://a' }] })) }).toThrow(/name/)
    expect(() => { assertConfig(config({ probes: [{ name: 'x', url: 'http://a', credentialRef: '' }] })) }).toThrow(/credentialRef/)
    expect(() => { assertConfig(config({ probes: [{ name: 'x', url: 'http://a', credentialRef: 'bad-ref' }] })) }).toThrow(/credentialRef/)
  })
})
