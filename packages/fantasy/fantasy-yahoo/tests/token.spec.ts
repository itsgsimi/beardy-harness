import { mkdtemp, readFile, readdir, stat, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { YahooTokenStore, parseTokenRecord, validateTokenPaths, withTokenLock } from '../src/token.ts'
import type { YahooTokenRecord } from '../src/token.ts'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const secret = 'private-fixture-secret'
function record(ageSeconds = 0): YahooTokenRecord {
  return {
    consumer_key: 'fixture-client', consumer_secret: secret,
    access_token: 'fixture-access', refresh_token: 'fixture-refresh',
    token_type: 'bearer', token_time: Date.now() / 1000 - ageSeconds,
  }
}

async function setup(withStore = true) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fantasy-token-'))
  roots.push(root)
  const home = join(root, 'home')
  const tokenFile = join(home, 'fantasy.json')
  const imported = join(root, 'python-cache.json')
  await import('node:fs/promises').then(fs => fs.mkdir(home, { mode: 0o700 }))
  vi.stubEnv('DSH_HOME', home)
  if (withStore) await writeFile(tokenFile, JSON.stringify(record(4_000)), { mode: 0o600 })
  await writeFile(imported, JSON.stringify(record()), { mode: 0o600 })
  const config = { tokenFile, importFrom: imported, lockWaitMs: 2_000, lockStaleMs: 10_000, requestTimeoutMs: 1_000 }
  return { root, home, tokenFile, imported, config }
}

describe('private Yahoo token store', () => {
  it('validates location, format, and file permissions at load', async () => {
    const h = await setup()
    expect(validateTokenPaths(h.config)).toEqual({ tokenFile: h.tokenFile, importFrom: h.imported })
    expect(() => new YahooTokenStore({ ...h.config, tokenFile: join(h.root, 'outside.json') })).toThrow('under DSH_HOME')
    expect(() => new YahooTokenStore({ ...h.config, requestTimeoutMs: 6_000 })).toThrow('timeouts')
    await import('node:fs/promises').then(fs => fs.chmod(h.tokenFile, 0o644))
    expect(() => new YahooTokenStore(h.config)).toThrow('0600')
    await writeFile(h.tokenFile, JSON.stringify({ ...record(), consumer_secret: '' }), { mode: 0o600 })
    await import('node:fs/promises').then(fs => fs.chmod(h.tokenFile, 0o600))
    expect(() => new YahooTokenStore(h.config)).toThrow('consumer_secret')
    expect(() => parseTokenRecord({})).toThrow('consumer_key')
    await rm(h.tokenFile)
    const { importFrom: _importFrom, ...withoutImport } = h.config
    expect(() => new YahooTokenStore(withoutImport)).toThrow('no importFrom')
  })

  it('imports once without changing the Python source and creates a private store', async () => {
    const h = await setup(false)
    const source = await readFile(h.imported, 'utf8')
    const store = new YahooTokenStore(h.config)
    expect(await store.accessToken()).toBe('fixture-access')
    expect((await stat(h.tokenFile)).mode & 0o777).toBe(0o600)
    expect(await readFile(h.imported, 'utf8')).toBe(source)
    await writeFile(h.imported, JSON.stringify({ ...record(), access_token: 'changed-import' }))
    expect(await store.accessToken()).toBe('fixture-access')
    expect((await readFile(h.tokenFile, 'utf8'))).not.toContain('changed-import')
  })

  it('re-reads under the lock so two holders make one refresh and atomically replace the file', async () => {
    const h = await setup()
    let calls = 0
    const fetcher: typeof fetch = async (_url, init) => {
      calls++
      expect(init?.method).toBe('POST')
      await new Promise(resolve => setTimeout(resolve, 20))
      return new Response(JSON.stringify({
        access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'bearer',
      }), { status: 200 })
    }
    const a = new YahooTokenStore(h.config, fetcher)
    const b = new YahooTokenStore(h.config, fetcher)
    expect(await Promise.all([a.accessToken(), b.accessToken()])).toEqual(['new-access', 'new-access'])
    expect(calls).toBe(1)
    const written = parseTokenRecord(JSON.parse(await readFile(h.tokenFile, 'utf8')))
    expect(written).toMatchObject({ access_token: 'new-access', refresh_token: 'new-refresh', consumer_secret: secret })
    expect((await stat(h.tokenFile)).mode & 0o777).toBe(0o600)
    expect((await readdir(h.home)).filter(name => name.includes('.tmp-'))).toEqual([])
    expect(JSON.stringify(await a.status())).not.toContain(secret)
  })

  it('serializes contending operations and retires an expired dead-owner lock', async () => {
    const h = await setup()
    let release: (() => void) | undefined
    let entered: (() => void) | undefined
    const inside = new Promise<void>((resolve) => { entered = resolve })
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const order: string[] = []
    const first = withTokenLock(h.tokenFile, 2_000, 1_000, async () => {
      order.push('first')
      entered?.()
      await waiting
    })
    await inside
    const second = withTokenLock(h.tokenFile, 2_000, 1_000, async () => { order.push('second') })
    expect(order).toEqual(['first'])
    release?.()
    await Promise.all([first, second])
    expect(order).toEqual(['first', 'second'])
    await writeFile(`${h.tokenFile}.lock`, JSON.stringify({ pid: 999999999, createdAt: Date.now() - 5_000 }), { mode: 0o600 })
    await withTokenLock(h.tokenFile, 2_000, 1_000, async () => { order.push('recovered') })
    expect(order.at(-1)).toBe('recovered')
    expect((await readdir(h.home)).filter(name => name.endsWith('.lock'))).toEqual([])
  })

  it('returns only safe errors for a rejected refresh and bad response', async () => {
    const h = await setup()
    const denied = new YahooTokenStore(h.config, async () => new Response(secret, { status: 401 }))
    await expect(denied.accessToken()).rejects.toThrow('HTTP 401')
    const malformed = new YahooTokenStore(h.config, async () => new Response('{}', { status: 200 }))
    await expect(malformed.accessToken()).rejects.toThrow('invalid token response')
    const invalidJson = new YahooTokenStore(h.config, async () => new Response('{broken', { status: 200 }))
    await expect(invalidJson.accessToken()).rejects.toThrow('invalid token response')
    expect((await readFile(h.tokenFile, 'utf8'))).toContain('fixture-access')
  })
})
