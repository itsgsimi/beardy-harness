/**
 * The Beardy bundle's substance is its patch file: the manifest declaration
 * and the profile overrides must remain loadable and explicit.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

describe('dsh-beardy bundle', () => {
  it('declares the profile patch and its Beardy defaults', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed: unknown = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    expect(Array.isArray(parsed)).toBe(true)
    if (!Array.isArray(parsed)) throw new TypeError('Beardy patch must contain an entry list')
    const rows = parsed.flatMap((entry): JsonRecord[] => {
      if (!isRecord(entry)) return []
      return Array.isArray(entry.insert) ? entry.insert.filter(isRecord) : [entry]
    })
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'agent-presets' }),
      expect.objectContaining({ id: 'session-query-sqlite' }),
      expect.objectContaining({ id: 'tool-session-query', name: '@deepseek-ai/dsh-tool-session-query' }),
      expect.objectContaining({ id: 'tool-web' }),
    ]))
    expect(rows.find(row => row.id === 'agent-presets')?.config).toEqual({ default: 'beardy' })
    expect(rows.find(row => row.id === 'session-query-sqlite')?.config).toEqual({
      path: { __jsExpr: "dshHomePath('session-search.sqlite')" },
      openAt: 'first-search',
    })
    expect(rows.find(row => row.id === 'tool-web')?.config).toEqual({
      fetch: true,
      searchTimeoutMs: 60000,
    })
    expect(rows.find(row => row.id === 'tool-web')?.disabled).toBe(false)
    expect(rows.find(row => row.id === 'web')?.config).toEqual({
      searchProvider: 'searxng',
      fetchProvider: 'http',
    })
    expect(rows.find(row => row.id === 'web-search-deepseek')?.disabled).toBe(true)
    expect(rows.find(row => row.id === 'web-search-searxng')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-web-search-searxng',
      config: { baseURL: { __jsExpr: "process.env.SEARXNG_BASE_URL ?? 'http://127.0.0.1:8080'" } },
    }))
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-session-query-sqlite')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-tool-session-query')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-web-search-searxng')
  })

  it('layers the creator preset instead of duplicating its capability roster', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const presetPath = resolve(root, '../../preset/agent-presets/presets/beardy/agent.cordis.yml')
    const parsed: unknown = yaml.load(readFileSync(presetPath, 'utf8'), { schema: entryListSchema })
    expect(Array.isArray(parsed)).toBe(true)
    if (!Array.isArray(parsed) || !isRecord(parsed[0])) {
      throw new TypeError('Beardy preset must contain an entry list')
    }
    const entry = parsed[0]
    expect(entry.id).toBe('creator')
    expect(entry.name).toBe('@deepseek-ai/dsh-agent-presets/include')
    if (!isRecord(entry.config)) throw new TypeError('Beardy include must have config')
    expect(entry.config.path).toBe('../cordis/agent.cordis.yml')
    if (!Array.isArray(entry.config.patches)) throw new TypeError('Beardy include must have patches')
    const patchIds = entry.config.patches.flatMap(value =>
      isRecord(value) && typeof value.id === 'string' ? [value.id] : [],
    )
    expect(patchIds).toEqual(expect.arrayContaining(['persona', 'agent-instructions']))
    const instructions: unknown = parsed.find(value => isRecord(value) && value.id === 'agent-instructions')
    if (!isRecord(instructions) || !isRecord(instructions.config)) throw new TypeError('agent-instructions row config')
    expect(instructions.config.userGlobalInstructionCandidates)
      .toEqual(['AGENTS.md', 'SOUL.md', 'USER.md', 'MEMORY.md'])
    expect(instructions.config.frozenUserGlobalInstructionCandidates)
      .toEqual(['USER.md', 'MEMORY.md'])
    const rows = parsed.filter(isRecord)
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'tool-memory', name: '@deepseek-ai/dsh-tool-memory' }),
    ]))
  })
})
