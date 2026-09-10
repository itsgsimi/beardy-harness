/** Recorded Discord menus, rich replies, and native status through the shipped Web profile. */

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import {
  assertPersistedSessionVersion,
  formatSystemPromptSnapshot,
  formatToolSchemasSnapshot,
  latestPersistedSessionPaths,
  materializeProfilePatch,
  normalizeSessionSnapshots,
  normalizedHeaders,
  normalizedSystemPrompts,
  normalizedToolSchemas,
  parseSnapshotManifest,
  redactSessionSnapshotIds,
  refreshFixtureReplacements,
  scrubSessionSnapshot,
  sessionFixtureNames,
  stabilizeFixtureMessageIds,
  stabilizeRefreshLog,
  tokenizeSessionFixtureCwd,
} from '@deepseek-ai/dsh-session-snapshot'

const scenarioDir = fileURLToPath(new URL('./discord-rich-reply/', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const mode = process.env.DSH_SNAPSHOT ?? 'replay'
const prefix = 'DSH_DISCORD_SNAPSHOT '

interface DiscordExchange {
  method: string
  path: string
  body?: unknown
}

function records(content: string): Record<string, unknown>[] {
  return content.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
}

function taskFromFixture(fixture: string): string {
  for (const record of records(fixture)) {
    if (record.type !== 'user/message') continue
    const data = record.data as { source: { kind: string }; content: { type: string; text?: string }[] }
    if (data.source.kind !== 'discord' && data.source.kind !== 'user') continue
    return data.content.flatMap(block => block.type === 'text' ? [block.text ?? ''] : []).join('\n')
  }
  throw new Error('Discord snapshot has no recorded inbound task')
}

async function runScenario(fixture: string): Promise<{
  content: string
  cwd: string
  exchanges: DiscordExchange[]
}> {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-discord-snapshot-'))
  try {
    const fixturePath = join(cwd, '.replay.jsonl')
    await writeFile(fixturePath, fixture.replaceAll('{{cwd}}', cwd))
    const patchDir = join(cwd, '.patches')
    await mkdir(patchDir)
    const patch = materializeProfilePatch(join(scenarioDir, 'cordis.yml'), cwd, patchDir, 0)
    const launch = resolveExampleLaunch({
      srcBin: join(repoRoot, 'apps/cli/src/bin.ts'),
      sourceImport: 'tsx/esm',
      tsconfigPath: join(repoRoot, 'tsconfig.base.json'),
      configArgs: ['--profile', 'web', '--patch', patch, '--port', '0', '--no-open'],
      env: {
        DSH_HOME: join(cwd, '.dsh'),
        DSH_AGENTS_HOME: join(cwd, '.agents'),
        DSH_BUNDLED_SKILL_DIR: join(cwd, '.bundled-skills'),
        DSH_TELEMETRY_DISABLED: '1',
        DSH_SNAPSHOT_FILE: fixturePath,
        DSH_DISCORD_SNAPSHOT_TOKEN: 'snapshot-discord-token',
        DSH_DISCORD_SNAPSHOT_TASK: taskFromFixture(fixture),
      },
    })
    const child = spawn(launch.command, launch.args, {
      cwd,
      env: { ...process.env, ...launch.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    let stdout = ''
    let pendingLine = ''
    const exchanges: DiscordExchange[] = []
    const complete = Promise.withResolvers<void>()
    const closed = new Promise<void>(resolve => child.once('close', () => { resolve() }))
    child.once('error', error => { complete.reject(error) })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
      pendingLine += chunk
      const lines = pendingLine.split('\n')
      pendingLine = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith(prefix)) continue
        const value = JSON.parse(line.slice(prefix.length)) as DiscordExchange | { complete: true }
        if ('complete' in value) complete.resolve()
        else exchanges.push(value)
      }
    })
    child.once('close', () => { complete.reject(new Error(`Discord host exited before status reply\n${stderr}\n${stdout}`)) })
    const deadline = setTimeout(() => {
      complete.reject(new Error(`Discord snapshot did not reach the status reply\n${stderr}\n${stdout}`))
    }, 100_000)
    try {
      await complete.promise
    } finally {
      clearTimeout(deadline)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      const fallback = setTimeout(() => { child.kill('SIGKILL') }, 10_000)
      await closed
      clearTimeout(fallback)
    }
    const sessionsRoot = join(cwd, '.dsh', 'sessions')
    const paths = latestPersistedSessionPaths(await readdir(sessionsRoot, { recursive: true }))
    expect(paths).toHaveLength(1)
    const path = join(sessionsRoot, paths[0] as string)
    const content = await readFile(path, 'utf8')
    assertPersistedSessionVersion(basename(path), content)
    const statusReplyIndex = exchanges.findIndex(exchange =>
      exchange.method === 'PATCH' && exchange.path.endsWith('/messages/@original'))
    expect(statusReplyIndex).toBeGreaterThanOrEqual(0)
    // The protocol observation ends with the status response, before teardown changes the command roster.
    return { content, cwd, exchanges: exchanges.slice(0, statusReplyIndex + 1) }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

it.skipIf(mode === 'record')(`${mode} Discord rich replies and native status through dsh --profile web`, async () => {
  const manifestPath = join(scenarioDir, 'snapshot.yml')
  const manifest = parseSnapshotManifest(await readFile(manifestPath, 'utf8'), manifestPath)
  expect(manifest.profile).toBe('web')
  expect(manifest.recording).toBe('authored')
  const [fixtureName] = sessionFixtureNames(await readdir(scenarioDir))
  if (fixtureName === undefined) throw new Error('Discord snapshot has no Session fixture')
  const fixturePath = join(scenarioDir, fixtureName)
  let expected = await readFile(fixturePath, 'utf8')
  const actual = await runScenario(expected)
  const header = records(actual.content)[0] as { id: string; createdAt: number }
  const context = { sessionIds: [header.id], cwd: actual.cwd }
  const prompts = normalizedSystemPrompts(actual.content, context)
  const schemas = normalizedToolSchemas(actual.content, context)
  const prompt = formatSystemPromptSnapshot(prompts[0] as string, prompts.slice(1))
  const schema = formatToolSchemasSnapshot(schemas[0] as unknown[], schemas.slice(1))
  const wire = JSON.stringify(actual.exchanges, null, 2)
    .replaceAll(header.id, '{{session:1}}').replaceAll(actual.cwd, '{{cwd}}') + '\n'
  if (mode === 'refresh') {
    const replacements = refreshFixtureReplacements([{ ...header, content: actual.content }], [expected])
    expected = redactSessionSnapshotIds(stabilizeFixtureMessageIds([
      scrubSessionSnapshot(tokenizeSessionFixtureCwd(stabilizeRefreshLog(
        actual.content, expected, replacements, context,
      ))),
    ], [expected]))[0] as string
    await writeFile(fixturePath, expected)
    await writeFile(join(scenarioDir, 'system-prompt.expected.md'), prompt)
    await writeFile(join(scenarioDir, 'tool-schemas.expected.json'), schema)
    await writeFile(join(scenarioDir, 'discord.expected.json'), wire)
  }
  expect(normalizeSessionSnapshots([actual.content], context).map(records))
    .toEqual(normalizeSessionSnapshots([expected], { sessionIds: ['{{session:1}}'], cwd: '{{cwd}}' }).map(records))
  expect(normalizedHeaders(actual.content, context).map(value => ({ ...value as object, system: '{{system}}', tools: '{{tools}}' })))
    .toEqual(normalizedHeaders(expected, { sessionIds: [], cwd: '{{cwd}}' }))
  expect(prompt).toBe(await readFile(join(scenarioDir, 'system-prompt.expected.md'), 'utf8'))
  expect(schema).toBe(await readFile(join(scenarioDir, 'tool-schemas.expected.json'), 'utf8'))
  expect(wire).toBe(await readFile(join(scenarioDir, 'discord.expected.json'), 'utf8'))
  expect(actual.exchanges.some(exchange => exchange.method === 'PUT' && exchange.path.endsWith('/commands'))).toBe(true)
  expect(wire).toContain('DISCORD_RICH_REPLY_OK')
  expect(wire).toContain('```ts')
  expect(wire).toContain('embeds')
  expect(actual.exchanges.some(exchange => exchange.method === 'PATCH' && exchange.path.endsWith('/messages/@original'))).toBe(true)
})
