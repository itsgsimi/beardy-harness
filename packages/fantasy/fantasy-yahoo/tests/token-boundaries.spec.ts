import { chmod, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { YahooTokenStore, parseTokenRecord, validateTokenPaths, withTokenLock, writeTokenAtomic } from '../src/token.ts'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fantasy-token-boundary-'))
  roots.push(root)
  const home = join(root, 'home')
  await mkdir(home, { mode: 0o700 })
  vi.stubEnv('DSH_HOME', home)
  const tokenFile = join(home, 'oauth.json')
  const record = { consumer_key: 'fixture-client', consumer_secret: 'fixture-secret',
    access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'bearer',
    token_time: Date.now() / 1000 }
  await writeFile(tokenFile, JSON.stringify(record), { mode: 0o600 })
  const config = { tokenFile, lockWaitMs: 40, lockStaleMs: 1_000, requestTimeoutMs: 100 }
  return { root, home, tokenFile, record, config }
}

it('rejects malformed tokens and unsafe placement before mounting', async () => {
  const h = await setup()
  for (const value of [null, [], 'token']) expect(() => parseTokenRecord(value)).toThrow('invalid')
  for (const token_time of [undefined, -1, Number.NaN, 8.64e12 + 1, 'now']) {
    expect(() => parseTokenRecord({ ...h.record, token_time })).toThrow('token_time')
  }
  for (const tokenFile of ['relative.json', h.home, join(h.home, 'bad.txt'), join(h.root, 'outside.json')]) {
    expect(() => validateTokenPaths({ ...h.config, tokenFile })).toThrow()
  }
  for (const importFrom of ['relative.json', h.tokenFile]) {
    expect(() => validateTokenPaths({ ...h.config, importFrom })).toThrow('importFrom')
  }
  for (const override of [
    { lockWaitMs: 0 }, { lockWaitMs: 300_001 }, { lockStaleMs: 999 },
    { lockStaleMs: 3_600_001 }, { requestTimeoutMs: 0 }, { requestTimeoutMs: 120_001 },
    { requestTimeoutMs: 500 },
  ]) expect(() => validateTokenPaths({ ...h.config, ...override })).toThrow('timeouts')
  await writeFile(h.tokenFile, '{broken')
  expect(() => new YahooTokenStore(h.config)).toThrow('invalid')
  await rm(h.tokenFile)
  await mkdir(h.tokenFile)
  expect(() => new YahooTokenStore(h.config)).toThrow('regular file')
  await rm(h.tokenFile, { recursive: true })
  await symlink(join(h.root, 'missing'), h.tokenFile)
  expect(() => new YahooTokenStore(h.config)).toThrow('regular file')
  await rm(h.tokenFile)
  const child = join(h.home, 'child')
  await symlink(h.root, child)
  expect(() => validateTokenPaths({ ...h.config, tokenFile: join(child, 'oauth.json') }))
    .toThrow('parent must be a regular directory')
  await rm(child)
  await writeFile(child, 'not a directory', { mode: 0o600 })
  expect(() => validateTokenPaths({ ...h.config, tokenFile: join(child, 'oauth.json') }))
    .toThrow('parent must be a regular directory')
  await rm(child)
  await mkdir(child)
  await writeFile(join(child, 'oauth.json'), JSON.stringify(h.record), { mode: 0o600 })
  expect(validateTokenPaths({ ...h.config, tokenFile: join(child, 'oauth.json') }).tokenFile)
    .toBe(join(child, 'oauth.json'))
  expect(() => validateTokenPaths({ ...h.config, tokenFile: join(h.home, 'missing', 'oauth.json'),
    importFrom: join(h.root, 'import.json') })).toThrow('token store')
})

it('rechecks permissions and JSON after load and keeps write errors private', async () => {
  const h = await setup()
  const store = new YahooTokenStore(h.config, async () => { throw new Error('fixture-secret') })
  await chmod(h.tokenFile, 0o644)
  await expect(store.accessToken()).rejects.toThrow('0600')
  await chmod(h.tokenFile, 0o600)
  await writeFile(h.tokenFile, '{broken')
  await expect(store.accessToken()).rejects.toThrow('invalid')
  await writeFile(h.tokenFile, JSON.stringify({ ...h.record, consumer_secret: '' }))
  await expect(store.accessToken()).rejects.toThrow('consumer_secret')
  await writeFile(h.tokenFile, JSON.stringify({ ...h.record, token_time: Date.now() / 1000 - 4_000 }))
  await expect(store.accessToken()).rejects.toThrow('token endpoint unavailable')
  await writeFile(h.tokenFile, JSON.stringify(h.record))
  const future = { ...h.record, token_time: Date.now() / 1000 + 100 }
  await writeTokenAtomic(h.tokenFile, future)
  expect((await stat(h.tokenFile)).mode & 0o777).toBe(0o600)
  expect(await store.status()).toMatchObject({ tokenAgeSeconds: 0 })
  expect((await readdir(h.home)).filter(name => name.includes('.tmp-'))).toEqual([])
  await mkdir(join(h.home, 'as-directory'))
  await expect(writeTokenAtomic(join(h.home, 'as-directory'), h.record)).rejects.toThrow()
  expect((await readdir(h.home)).filter(name => name.includes('.tmp-'))).toEqual([])
  const throwing = { ...h.record }
  Object.defineProperty(throwing, 'access_token', { get() { throw new Error('serialization failed') } })
  await expect(writeTokenAtomic(h.tokenFile, throwing)).rejects.toThrow('serialization failed')
  expect((await readdir(h.home)).filter(name => name.includes('.tmp-'))).toEqual([])
})

it('times out behind a live owner and ignores malformed or fresh locks', async () => {
  const h = await setup()
  const lockPath = `${h.tokenFile}.lock`
  const cases = [
    '{bad',
    JSON.stringify({ pid: 'not-a-pid', createdAt: Date.now() - 10_000 }),
    JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
  ]
  for (const value of cases) {
    await writeFile(lockPath, value, { mode: 0o600 })
    await expect(withTokenLock(h.tokenFile, 20, 1_000, async () => 'entered')).rejects.toThrow('timed out')
    await rm(lockPath)
  }
  await mkdir(lockPath)
  await expect(withTokenLock(h.tokenFile, 20, 1_000, async () => 'entered')).rejects.toThrow('timed out')
  await rm(lockPath, { recursive: true })
  await expect(withTokenLock(join(h.home, 'missing', 'oauth.json'), 20, 1_000, async () => 'entered'))
    .rejects.toThrow('lock unavailable')
  const store = new YahooTokenStore(h.config)
  await rm(h.tokenFile)
  await expect(store.accessToken()).rejects.toThrow('missing')
})

it('retires an over-age live lock and releases after a failing operation', async () => {
  const h = await setup()
  const lockPath = `${h.tokenFile}.lock`
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() - 3_000 }), { mode: 0o600 })
  await expect(withTokenLock(h.tokenFile, 200, 1_000, async () => { throw new Error('operation failed') }))
    .rejects.toThrow('operation failed')
  expect(await readFile(h.tokenFile, 'utf8')).toContain('fixture-access')
  expect((await readdir(h.home)).filter(name => name.endsWith('.lock'))).toEqual([])
  await writeFile(lockPath, JSON.stringify({ pid: 0, createdAt: Date.now() - 3_000 }), { mode: 0o600 })
  expect(await withTokenLock(h.tokenFile, 200, 1_000, async () => 'recovered')).toBe('recovered')
  const stale = JSON.stringify({ pid: 0, createdAt: Date.now() - 3_000 })
  await writeFile(lockPath, stale, { mode: 0o600 })
  const claim = `${lockPath}.takeover-${createHash('sha256').update(stale).digest('hex')}`
  await writeFile(claim, '', { mode: 0o600 })
  await expect(withTokenLock(h.tokenFile, 20, 1_000, async () => 'entered')).rejects.toThrow('timed out')
  await rm(lockPath)
  await rm(claim)
  await withTokenLock(h.tokenFile, 200, 1_000, async () => {
    const replacement = join(h.home, 'replacement')
    await writeFile(replacement, 'replacement', { mode: 0o600 })
    await rm(lockPath)
    await rename(replacement, lockPath)
  })
  expect(await readFile(lockPath, 'utf8')).toBe('replacement')
  await rm(lockPath)
})
