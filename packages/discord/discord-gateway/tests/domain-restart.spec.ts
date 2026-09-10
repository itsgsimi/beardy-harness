import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import type { DiscordMessageBody } from '@deepseek-ai/dsh-tool-discord'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { discordGatewayDomainSpec } from '../src/domain.ts'
import { DiscordOutbox } from '../src/outbox.ts'

const roots: string[] = []
const contexts: Context[] = []
const queues: DiscordOutbox[] = []

afterEach(async () => {
  for (const queue of queues.splice(0).reverse()) await queue.dispose()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function mount(root: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(storageJson, { root })
  await ctx.plugin(storageDomain, { backend: 'json' })
  return ctx
}

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-discord-domain-'))
  roots.push(root)
  return root
}

const legacyText = '| Name | Status |\n| --- | --- |\n| A | complete |'

function versionTwo(root: string) {
  return {
    unit: { name: 'discord_gateway', version: 2 }, global: null,
    tables: {
      conversations: { channel: { channelId: 'channel', sessionId: 'existing-session',
        agentPreset: 'beardy-discord', workspacePath: root, openedAt: 1, lastInboundAt: 2, deliveredThrough: 8 } },
      outbox: {
        legacy: { channelId: 'channel', chunks: ['already delivered', legacyText], cursor: 1,
          ordinal: 1, createdAt: 1, nextAttemptAt: 0, attempts: 2 },
        receipt: { channelId: 'channel', chunks: [], cursor: 0,
          ordinal: 2, createdAt: 1, nextAttemptAt: 0, attempts: 0, completedAt: 2 },
      },
    },
  }
}

describe('Discord single-file domain upgrade', () => {
  it('requires a validated unit upgrade, preserves v2 records, and resumes rich and legacy deliveries after reopen', async () => {
    const root = await directory()
    const path = join(root, 'discord_gateway.json')
    const document = versionTwo(root)
    const original = `${JSON.stringify(document, null, 2)}\n`
    await writeFile(path, original, { flag: 'wx' })
    const first = await mount(root)
    await expect(first.storageDomain.open(discordGatewayDomainSpec)).rejects.toMatchObject({ code: 'version-mismatch' })
    expect(await readFile(path, 'utf8')).toBe(original)

    // Validate stored v2 rows with the current schemas before the operator changes the unit stamp.
    const validated = await first.storageDomain.open({ ...discordGatewayDomainSpec, version: 2 })
    expect(Object.fromEntries(validated.table('conversations').entries())).toEqual(document.tables.conversations)
    expect(Object.fromEntries(validated.table('outbox').entries())).toEqual(document.tables.outbox)
    await validated.close()
    const backup = join(root, 'discord_gateway.v2.backup.json')
    await writeFile(backup, await readFile(path), { flag: 'wx' })
    const upgraded = { ...document, unit: { ...document.unit, version: 3 } }
    const candidate = join(root, 'discord_gateway.v3.candidate.json')
    await writeFile(candidate, `${JSON.stringify(upgraded, null, 2)}\n`, { flag: 'wx' })
    await rename(candidate, path)
    expect(await readFile(path, 'utf8')).toBe(original.replace('"version": 2', '"version": 3'))
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(upgraded)
    expect(await readFile(backup, 'utf8')).toBe(original)

    const current = await first.storageDomain.open(discordGatewayDomainSpec)
    const rich: DiscordMessageBody = { content: '', embeds: [{ title: 'Status', description: '**Ready**' }],
      components: [{ type: 1, components: [{ type: 2, style: 2, custom_id: 'dsh:command:status', label: 'Current status' }] }],
    }
    const settings = { outboxMaxPending: 10, outboxMaxChars: 5000, outboxRetryMs: 1000,
      outboxMaxRetryMs: 8000, outboxMaxReceipts: 10 }
    const firstPost = vi.fn(async () => {})
    const beforeRestart = new DiscordOutbox(current.table('outbox'), settings, firstPost, vi.fn())
    queues.push(beforeRestart)
    await beforeRestart.enqueue('rich', 'channel', [rich])
    await beforeRestart.dispose()
    expect(firstPost).not.toHaveBeenCalled()
    expect(current.table('outbox').get('legacy')).toEqual(document.tables.outbox.legacy)
    expect(current.table('outbox').get('receipt')).toEqual(document.tables.outbox.receipt)
    await first.fiber.dispose()

    const second = await mount(root)
    const reopened = await second.storageDomain.open(discordGatewayDomainSpec)
    const table = reopened.table('outbox')
    expect(table.get('rich')?.chunks).toEqual([rich])
    expect(Object.fromEntries(reopened.table('conversations').entries())).toEqual(document.tables.conversations)
    const completed = new Set<string>()
    const delivered = Promise.withResolvers<undefined>()
    second.on('domain/changed', (change) => {
      if (change.domain === 'discord_gateway' && change.table === 'outbox' && change.operation === 'put'
        && table.get(change.key)?.completedAt !== undefined && ['legacy', 'rich'].includes(change.key)) {
        completed.add(change.key)
        if (completed.size === 2) delivered.resolve(undefined)
      }
    })
    const sent: (string | DiscordMessageBody)[] = []
    const afterRestart = new DiscordOutbox(table, settings, async (_channel, body) => { sent.push(body) }, vi.fn())
    queues.push(afterRestart)
    afterRestart.start()
    await delivered.promise
    await afterRestart.dispose()
    expect(sent).toEqual([legacyText, rich])
    expect(table.get('receipt')).toEqual(document.tables.outbox.receipt)
    expect(Object.fromEntries(reopened.table('conversations').entries())).toEqual(document.tables.conversations)
    expect(await readFile(backup, 'utf8')).toBe(original)
  })

  it('rejects invalid legacy records during validation without modifying the stored unit', async () => {
    const root = await directory()
    const path = join(root, 'discord_gateway.json')
    const document = versionTwo(root)
    document.tables.outbox.legacy.cursor = 3
    const original = `${JSON.stringify(document)}\n`
    await writeFile(path, original, { flag: 'wx' })
    const ctx = await mount(root)
    await expect(ctx.storageDomain.open({ ...discordGatewayDomainSpec, version: 2 })).rejects.toMatchObject({
      code: 'invalid-record', detail: { table: 'outbox', key: 'legacy' },
    })
    expect(await readFile(path, 'utf8')).toBe(original)
  })
})
