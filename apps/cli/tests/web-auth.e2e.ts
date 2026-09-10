/** Real `dsh web` authentication against a temporary Harness home. */

import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import WebSocket from 'ws'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const DSH_SOURCE_BIN = join(REPO_ROOT, 'apps/cli/src/bin.ts')

interface RunningWeb {
  readonly child: ChildProcess
  readonly closed: Promise<void>
  readonly launchUrl: string
  readonly output: () => string
}

interface HttpResult {
  readonly status: number
  readonly body: string
}

function redact(output: string): string {
  return output.replace(/([?&]token=)[^\s)]+/gu, '$1<redacted>')
}

function cleanEnvironment(root: string, dshHome: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name)))
  return {
    ...env,
    DSH_AGENTS_HOME: join(root, '.agents'),
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    NODE_NO_WARNINGS: '1',
    SSH_CONNECTION: '',
    SSH_TTY: '',
  }
}

/** Start the shipped CLI with an OS-allocated port and wait for its readiness URL. */
async function startWeb(root: string, dshHome: string, flags: string[] = []): Promise<RunningWeb> {
  const launch = resolveExampleLaunch({
    srcBin: DSH_SOURCE_BIN,
    mode: 'lib',
    configArgs: ['--profile', 'web', '--no-open', '--port', '0', ...flags],
  })
  const child = spawn(launch.command, launch.args, {
    cwd: root,
    env: { ...cleanEnvironment(root, dshHome), ...launch.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const closed = new Promise<void>((resolve) => { child.once('close', () => { resolve() }) })
  let output = ''
  const readiness = new Promise<string>((resolve, reject) => {
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }
    const timer = setTimeout(() => {
      fail(new Error(`dsh web did not become ready:\n${redact(output)}`))
    }, 90_000)
    const append = (chunk: Buffer | string): void => {
      output = `${output}${String(chunk)}`.slice(-100_000)
      const match = /dsh web: (http:\/\/[^\s]+)/u.exec(output)
      if (settled || match?.[1] === undefined) return
      settled = true
      clearTimeout(timer)
      resolve(match[1])
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.once('error', (error) => {
      fail(error)
    })
    child.once('exit', (code) => {
      fail(new Error(`dsh web exited before readiness (${String(code)}):\n${redact(output)}`))
    })
  })
  try {
    const launchUrl = await readiness
    return { child, closed, launchUrl, output: () => output }
  } catch (error) {
    await stopWeb({ child, closed })
    throw error
  }
}

async function stopWeb({ child, closed }: Pick<RunningWeb, 'child' | 'closed'>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  const forced = setTimeout(() => { child.kill('SIGKILL') }, 10_000)
  forced.unref()
  await closed
  clearTimeout(forced)
}

/** POST one real Remote envelope while controlling the wire Host header. */
function describeSettings(port: number, host: string, cookie?: string, origin?: string): Promise<HttpResult> {
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: 'web-auth-real-cli',
    method: 'settings/describe',
    payload: { args: {} },
  })
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/settings/describe',
      method: 'POST',
      headers: {
        host,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...cookie === undefined ? {} : { cookie },
        ...origin === undefined ? {} : { origin },
      },
    }, (res) => {
      const chunks: Uint8Array[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.once('error', reject)
    req.end(body)
  })
}

/** Open the browser's generation stream without an authentication cookie. */
async function readyWithoutCookie(url: URL): Promise<unknown> {
  const socket = new WebSocket(`${url.origin.replace(/^http/u, 'ws')}/api/remote.mux`)
  const closed = new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<unknown>((resolve, reject) => {
      timer = setTimeout(() => { reject(new Error('WebSocket generation did not become ready')) }, 10_000)
      socket.once('error', reject)
      socket.once('close', () => { reject(new Error('WebSocket closed before generation readiness')) })
      socket.once('open', () => {
        socket.send(JSON.stringify({
          type: 'open', streamId: 'web-auth-ready', endpoint: '$events', payload: { args: {} },
        }))
      })
      socket.once('message', (data) => {
        try {
          const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
          resolve(JSON.parse(bytes.toString('utf8')) as unknown)
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    })
  } finally {
    clearTimeout(timer)
    socket.terminate()
    await closed
    socket.removeAllListeners()
  }
}

describe('dsh web authentication through the real CLI', () => {
  it('rejects a forged loopback Host and preserves the browser cookie across restart', { timeout: 180_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-auth-real-cli-'))
    const dshHome = join(root, '.dsh')
    let first: RunningWeb | undefined
    let second: RunningWeb | undefined
    try {
      first = await startWeb(root, dshHome)
      const firstUrl = new URL(first.launchUrl)
      const port = Number(firstUrl.port)
      expect(firstUrl.origin).toBe(`http://127.0.0.1:${String(port)}`)
      expect(firstUrl.pathname).toBe('/')
      expect(firstUrl.searchParams.get('token')).toMatch(/^[A-Za-z0-9_-]{43}$/u)
      expect((await fetch(firstUrl.origin)).status).toBe(401)

      expect(await describeSettings(port, `localhost:${String(port)}`)).toEqual({
        status: 401,
        body: 'unauthorized',
      })

      const exchange = await fetch(first.launchUrl, { redirect: 'manual' })
      expect(exchange.status).toBe(303)
      expect(exchange.headers.get('location')).toBe('/')
      const setCookie = exchange.headers.get('set-cookie')
      if (setCookie === null) throw new Error('real CLI token exchange omitted Set-Cookie')
      expect(setCookie).toContain('HttpOnly')
      expect(setCookie).toContain('SameSite=Strict')
      expect(setCookie).not.toContain('Secure')
      const cookie = setCookie.split(';', 1)[0]!

      const authenticated = await describeSettings(port, firstUrl.host, cookie)
      expect(authenticated.status).toBe(200)
      const authenticatedBody = JSON.parse(authenticated.body) as unknown
      expect(authenticatedBody).toMatchObject({
        type: 'server-response',
        rpcId: 'web-auth-real-cli',
        result: { ok: true, value: { namespaces: expect.any(Array) as unknown } },
      })

      await stopWeb(first)
      first = undefined
      second = await startWeb(root, dshHome, ['--port', firstUrl.port])
      const secondUrl = new URL(second.launchUrl)
      expect(secondUrl.searchParams.get('token')).not.toBe(firstUrl.searchParams.get('token'))
      expect((await describeSettings(Number(secondUrl.port), secondUrl.host, cookie)).status).toBe(200)

      const credentialMode = (await stat(join(dshHome, '.credentials.yaml'))).mode & 0o777
      expect(credentialMode).toBe(0o600)
    } catch (error) {
      const evidence = [first?.output(), second?.output()].filter(value => value !== undefined).join('\n')
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${redact(evidence)}`, { cause: error })
    } finally {
      if (second !== undefined) await stopWeb(second)
      if (first !== undefined) await stopWeb(first)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('serves a clean LAN URL without cookies only under the explicit insecure flag', { timeout: 180_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-no-auth-real-cli-'))
    const dshHome = join(root, '.dsh')
    let running: RunningWeb | undefined
    try {
      running = await startWeb(root, dshHome, ['--host', '0.0.0.0', '--insecure-no-auth'])
      const url = new URL(running.launchUrl)
      const port = Number(url.port)
      expect(url.hostname).toBe('127.0.0.1')
      expect(url.pathname).toBe('/')
      expect(url.search).toBe('')
      expect(url.hash).toBe('')
      expect(running.output()).toContain('WARNING: --insecure-no-auth disables authentication.')
      expect(running.output()).not.toContain('token=')

      const rootPage = await fetch(url, { redirect: 'manual' })
      expect(rootPage.status).toBe(200)
      expect(rootPage.headers.get('set-cookie')).toBeNull()
      expect(rootPage.headers.get('content-type')).toContain('text/html')
      expect((await rootPage.text()).includes('__DSH_BOOT__')).toBe(true)
      const rpc = await describeSettings(port, url.host)
      expect(rpc.status).toBe(200)
      expect(JSON.parse(rpc.body) as unknown).toMatchObject({
        type: 'server-response', rpcId: 'web-auth-real-cli', result: { ok: true },
      })
      expect(await readyWithoutCookie(url)).toMatchObject({
        type: 'item', streamId: 'web-auth-ready', value: { type: 'ready', host: { home: homedir() } },
      })
      expect((await describeSettings(port, 'untrusted.invalid')).status).toBe(403)
      expect((await describeSettings(port, url.host, undefined, 'https://untrusted.invalid')).status).toBe(403)
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${redact(running?.output() ?? '')}`, { cause: error })
    } finally {
      if (running !== undefined) await stopWeb(running)
      await rm(root, { recursive: true, force: true })
    }
  })
})
