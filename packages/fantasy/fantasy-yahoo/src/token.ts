/** Private Yahoo OAuth store, one-time import, and single-owner refresh. @module @deepseek-ai/dsh-fantasy-yahoo/token */

import { randomUUID, createHash } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { lstatSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Validated yahoo_oauth-compatible token record kept outside model and log surfaces. */
export interface YahooTokenRecord {
  readonly consumer_key: string
  readonly consumer_secret: string
  readonly access_token: string
  readonly refresh_token: string
  readonly token_type: string
  readonly token_time: number
}

/** Lock and HTTP budgets configured by the deployment. */
export interface TokenStoreConfig {
  readonly tokenFile: string
  readonly importFrom?: string
  readonly lockWaitMs: number
  readonly lockStaleMs: number
  readonly requestTimeoutMs: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse all fields needed by both Yahoo clients without revealing values in an error.
 * @param value - untrusted JSON value.
 * @returns validated yahoo_oauth record.
 */
export function parseTokenRecord(value: unknown): YahooTokenRecord {
  if (!isRecord(value)) throw new Error('fantasy-yahoo: token store is invalid')
  for (const key of ['consumer_key', 'consumer_secret', 'access_token', 'refresh_token', 'token_type'] as const) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      throw new Error(`fantasy-yahoo: token store lacks ${key}`)
    }
  }
  if (typeof value['token_time'] !== 'number' || !Number.isFinite(value['token_time'])
    || value['token_time'] < 0 || value['token_time'] > 8.64e12) {
    throw new Error('fantasy-yahoo: token store lacks token_time')
  }
  return {
    consumer_key: value['consumer_key'] as string,
    consumer_secret: value['consumer_secret'] as string,
    access_token: value['access_token'] as string,
    refresh_token: value['refresh_token'] as string,
    token_type: value['token_type'] as string,
    token_time: value['token_time'],
  }
}

function readRecordSync(path: string): YahooTokenRecord {
  let info
  try { info = lstatSync(path) } catch { throw new Error('fantasy-yahoo: token store is missing') }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error('fantasy-yahoo: token store must be a private regular file (0600)')
  }
  try { return parseTokenRecord(JSON.parse(readFileSync(path, 'utf8'))) }
  catch (error) {
    if (error instanceof Error && error.message.startsWith('fantasy-yahoo:')) throw error
    throw new Error('fantasy-yahoo: token store is invalid')
  }
}

async function readRecord(path: string): Promise<YahooTokenRecord> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error('fantasy-yahoo: token store must be a private regular file (0600)')
  }
  try { return parseTokenRecord(JSON.parse(await readFile(path, 'utf8'))) }
  catch (error) {
    if (error instanceof Error && error.message.startsWith('fantasy-yahoo:')) throw error
    throw new Error('fantasy-yahoo: token store is invalid')
  }
}

/** Validate absolute store placement under the active DSH home and private import source.
 * @param config - store paths and timing bounds.
 * @returns canonical store and optional import paths.
 */
export function validateTokenPaths(config: TokenStoreConfig): { tokenFile: string; importFrom?: string } {
  const home = resolveDshHome()
  if (!isAbsolute(config.tokenFile)) throw new Error('fantasy-yahoo: tokenFile must be absolute')
  const tokenFile = resolve(config.tokenFile)
  const belowHome = relative(home, tokenFile)
  if (belowHome === '' || belowHome === '..' || belowHome.startsWith(`..${sep}`) || isAbsolute(belowHome)
    || !tokenFile.endsWith('.json')) {
    throw new Error('fantasy-yahoo: tokenFile must be a JSON file under DSH_HOME')
  }
  let parent = home
  for (const segment of belowHome.split(sep).slice(0, -1)) {
    parent = join(parent, segment)
    const info = lstatSync(parent, { throwIfNoEntry: false })
    if (info === undefined) break
    if (!info.isDirectory()) {
      throw new Error('fantasy-yahoo: tokenFile parent must be a regular directory under DSH_HOME')
    }
  }
  if (config.importFrom !== undefined && (!isAbsolute(config.importFrom) || resolve(config.importFrom) === tokenFile)) {
    throw new Error('fantasy-yahoo: importFrom must be a different absolute path')
  }
  if (!Number.isSafeInteger(config.lockWaitMs) || config.lockWaitMs < 1 || config.lockWaitMs > 300_000
    || !Number.isSafeInteger(config.lockStaleMs) || config.lockStaleMs < 1_000 || config.lockStaleMs > 3_600_000
    || !Number.isSafeInteger(config.requestTimeoutMs) || config.requestTimeoutMs < 1 || config.requestTimeoutMs > 120_000
    || config.requestTimeoutMs * 2 >= config.lockStaleMs) {
    throw new Error('fantasy-yahoo: lock and request timeouts must be valid and requestTimeoutMs below half lockStaleMs')
  }
  try {
    readRecordSync(tokenFile)
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'fantasy-yahoo: token store is missing') throw error
    if (config.importFrom === undefined) throw new Error('fantasy-yahoo: token store missing and no importFrom configured')
    readRecordSync(config.importFrom)
  }
  return { tokenFile, ...(config.importFrom === undefined ? {} : { importFrom: resolve(config.importFrom) }) }
}

function ownerAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

async function retireStaleLock(lockPath: string, staleMs: number): Promise<void> {
  let text: string
  let info
  try {
    info = await lstat(lockPath)
    if (!info.isFile() || info.isSymbolicLink()) return
    text = await readFile(lockPath, 'utf8')
  } catch {
    /* v8 ignore next -- Another process can remove the lock between EEXIST and this stale-lock read. */
    return
  }
  let entry: unknown
  try { entry = JSON.parse(text) } catch { return }
  if (!isRecord(entry) || typeof entry['pid'] !== 'number' || typeof entry['createdAt'] !== 'number') return
  const age = Date.now() - entry['createdAt']
  if (!Number.isFinite(age) || age < staleMs || (ownerAlive(entry['pid']) && age < staleMs * 2)) return
  const claim = `${lockPath}.takeover-${createHash('sha256').update(text).digest('hex')}`
  try {
    const handle = await open(claim, 'wx', 0o600)
    await handle.close()
  } catch { return }
  try {
    const current = await lstat(lockPath)
    /* v8 ignore next -- A concurrent lock replacement between the two inode reads leaves the successor untouched. */
    if (current.ino !== info.ino || await readFile(lockPath, 'utf8') !== text) return
    await rm(lockPath)
  } catch { /* Another contender may have released or replaced the lock. */ }
  finally { await rm(claim, { force: true }) }
}

/** Serialize one store operation across harness processes using an exclusive sibling lock.
 * @param tokenFile - private store path.
 * @param waitMs - acquisition deadline in milliseconds.
 * @param staleMs - stale lock threshold in milliseconds.
 * @param operation - exclusive store operation.
 * @returns the operation result.
 */
export async function withTokenLock<T>(
  tokenFile: string, waitMs: number, staleMs: number, operation: () => Promise<T>,
): Promise<T> {
  const lockPath = `${tokenFile}.lock`
  const deadline = Date.now() + waitMs
  let delay = 10
  let owned = false
  let lockInfo: Awaited<ReturnType<typeof lstat>> | undefined
  while (!owned) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }) + '\n')
        await handle.sync()
        lockInfo = await handle.stat()
        owned = true
      } finally { await handle.close() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('fantasy-yahoo: token lock unavailable')
      await retireStaleLock(lockPath, staleMs)
      if (Date.now() >= deadline) throw new Error('fantasy-yahoo: timed out waiting for token lock')
      await new Promise(resolve => setTimeout(resolve, delay))
      delay = Math.min(delay * 2, 250)
    }
  }
  try { return await operation() }
  finally {
    try {
      if ((await lstat(lockPath)).ino === lockInfo?.ino) await rm(lockPath)
    } catch { /* A stale owner can lose the lock before it reaches cleanup. */ }
  }
}

/** Commit a complete yahoo_oauth JSON record without exposing a partial file.
 * @param path - destination store path.
 * @param record - complete validated token record.
 */
export async function writeTokenAtomic(path: string, record: YahooTokenRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.tmp-${randomUUID()}`
  const handle = await open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(record, null, 2) + '\n')
    await handle.sync()
  } catch (error) {
    await handle.close()
    await rm(temp, { force: true })
    throw error
  }
  await handle.close()
  try { await rename(temp, path) }
  catch (error) { await rm(temp, { force: true }); throw error }
}

function responseRecord(raw: unknown, previous: YahooTokenRecord): YahooTokenRecord {
  if (!isRecord(raw) || typeof raw['access_token'] !== 'string' || typeof raw['refresh_token'] !== 'string'
    || typeof raw['token_type'] !== 'string') throw new Error('fantasy-yahoo: invalid token response')
  return parseTokenRecord({
    ...previous,
    access_token: raw['access_token'],
    refresh_token: raw['refresh_token'],
    token_type: raw['token_type'],
    token_time: Date.now() / 1000,
  })
}

/** Own the copied token and every refresh; the import source is never written. */
export class YahooTokenStore {
  /** Canonical DSH-owned private store path. */
  readonly tokenFile: string
  private readonly importFrom: string | undefined
  private readonly config: TokenStoreConfig
  private readonly fetcher: typeof fetch

  constructor(config: TokenStoreConfig, fetcher: typeof fetch = fetch) {
    const paths = validateTokenPaths(config)
    this.tokenFile = paths.tokenFile
    this.importFrom = paths.importFrom
    this.config = config
    this.fetcher = fetcher
  }

  private async initialized(): Promise<YahooTokenRecord> {
    try { return await readRecord(this.tokenFile) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (this.importFrom === undefined) throw new Error('fantasy-yahoo: token store missing')
      const importFrom = this.importFrom
      await mkdir(dirname(this.tokenFile), { recursive: true, mode: 0o700 })
      return await withTokenLock(this.tokenFile, this.config.lockWaitMs, this.config.lockStaleMs, async () => {
        try { return await readRecord(this.tokenFile) }
        catch (retryError) {
          /* v8 ignore next -- Another process can replace a missing store with invalid JSON while this owner waits. */
          if ((retryError as NodeJS.ErrnoException).code !== 'ENOENT') throw retryError
          const imported = await readRecord(importFrom)
          await writeTokenAtomic(this.tokenFile, imported)
          return imported
        }
      })
    }
  }

  /** Report the store age without credential material.
   * @returns token age and refresh time without credential material.
   */
  async status(): Promise<{ tokenAgeSeconds: number; lastRefresh: string }> {
    const record = await this.initialized()
    return { tokenAgeSeconds: Math.max(0, Math.floor(Date.now() / 1000 - record.token_time)),
      lastRefresh: new Date(record.token_time * 1000).toISOString() }
  }

  /** Read the public client ID for a human authorization URL.
   * @returns client ID; the secret remains private.
   */
  async clientId(): Promise<string> { return (await this.initialized()).consumer_key }

  /** Return a valid bearer token; refresh re-reads under the cross-process lock.
   * @param failedToken - optional token rejected by a 401 response.
   * @returns current access token for internal Yahoo requests only.
   */
  async accessToken(failedToken?: string): Promise<string> {
    const current = await this.initialized()
    if (Date.now() / 1000 - current.token_time < 3540 && current.access_token !== failedToken) return current.access_token
    return await withTokenLock(this.tokenFile, this.config.lockWaitMs, this.config.lockStaleMs, async () => {
      const latest = await readRecord(this.tokenFile)
      if (Date.now() / 1000 - latest.token_time < 3540 && latest.access_token !== failedToken) return latest.access_token
      const refreshed = await this.exchange(latest, { grant_type: 'refresh_token', refresh_token: latest.refresh_token })
      await writeTokenAtomic(this.tokenFile, refreshed)
      return refreshed.access_token
    })
  }

  /** Exchange one human-supplied code; no response data escapes this store.
   * @param code - authorization code supplied through the human command.
   * @param redirectUri - configured OAuth callback URI.
   */
  async authorize(code: string, redirectUri: string): Promise<void> {
    await this.initialized()
    await withTokenLock(this.tokenFile, this.config.lockWaitMs, this.config.lockStaleMs, async () => {
      const latest = await readRecord(this.tokenFile)
      const next = await this.exchange(latest, { grant_type: 'authorization_code', code, redirect_uri: redirectUri })
      await writeTokenAtomic(this.tokenFile, next)
    })
  }

  private async exchange(previous: YahooTokenRecord, fields: Record<string, string>): Promise<YahooTokenRecord> {
    const auth = Buffer.from(`${previous.consumer_key}:${previous.consumer_secret}`).toString('base64')
    let response: Response
    try {
      response = await this.fetcher('https://api.login.yahoo.com/oauth2/get_token', {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields),
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      })
    } catch { throw new Error('fantasy-yahoo: token endpoint unavailable') }
    if (!response.ok) throw new Error(`fantasy-yahoo: token exchange failed (HTTP ${response.status})`)
    let parsed: unknown
    try { parsed = await response.json() } catch { throw new Error('fantasy-yahoo: invalid token response') }
    return responseRecord(parsed, previous)
  }
}
