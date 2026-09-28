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
      dsh?: { bundle?: { patch?: string[] } }
    }
    expect(manifest.dsh?.bundle?.patch).toEqual([
      './cordis.patch.yml',
      './presets/beardy.patch.yml',
      './presets/beardy-unattended.patch.yml',
      './presets/beardy-discord.patch.yml',
    ])
    const parsed: unknown = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch![0]!), 'utf8'),
      { schema: entryListSchema },
    )
    expect(Array.isArray(parsed)).toBe(true)
    if (!Array.isArray(parsed)) throw new TypeError('Beardy patch must contain an entry list')
    const rows = parsed.flatMap((entry): JsonRecord[] => {
      if (!isRecord(entry)) return []
      return Array.isArray(entry.insert) ? entry.insert.filter(isRecord) : [entry]
    })
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'agent-preset-registry' }),
      expect.objectContaining({ id: 'session-query-sqlite' }),
      expect.objectContaining({ id: 'tool-session-query', name: '@deepseek-ai/dsh-tool-session-query' }),
      expect.objectContaining({ id: 'tool-web' }),
      expect.objectContaining({ id: 'tool-weather', name: '@deepseek-ai/dsh-tool-weather' }),
      expect.objectContaining({ id: 'tool-homelab', name: '@deepseek-ai/dsh-tool-homelab', disabled: true }),
    ]))
    expect(rows.find(row => row.id === 'agent-preset-registry')?.config).toEqual({ default: 'beardy' })
    expect(rows.find(row => row.id === 'session-query-sqlite')?.config).toEqual({
      path: { __jsExpr: "dshHomePath('session-search.sqlite')" },
      openAt: 'first-search',
    })
    expect(rows.find(row => row.id === 'tool-web')?.config).toEqual({
      fetch: true,
      searchTimeoutMs: 60000,
    })
    expect(rows.find(row => row.id === 'tool-web')?.disabled).toBe(false)
    expect(rows.find(row => row.id === 'brief-collector')).toMatchObject({
      name: '@deepseek-ai/dsh-brief-collector', disabled: true,
    })
    expect(rows.find(row => row.id === 'web')?.config).toEqual({
      searchProvider: 'searxng',
      fetchProvider: 'http',
    })
    expect(rows.find(row => row.id === 'agent-default-model')).toBeUndefined()
    expect(rows.find(row => row.id === 'discord-gateway')).not.toHaveProperty('config.modelSelection')
    expect(rows.find(row => row.id === 'cron')).not.toHaveProperty('config.modelSelection')
    expect(rows.find(row => row.id === 'web-search-deepseek')?.disabled).toBe(true)
    expect(rows.find(row => row.id === 'web-search-searxng')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-web-search-searxng',
    }))
    expect(rows.find(row => row.id === 'web-search-searxng')).not.toHaveProperty('config')
    expect(rows.find(row => row.id === 'fantasy-yahoo')).toMatchObject({
      name: '@deepseek-ai/dsh-fantasy-yahoo', disabled: true,
    })
    expect(rows.find(row => row.id === 'tool-fantasy')).toMatchObject({
      name: '@deepseek-ai/dsh-tool-fantasy', disabled: true,
    })
    expect(rows.find(row => row.id === 'fantasy-weekly-reports')).toMatchObject({
      name: '@deepseek-ai/dsh-fantasy-reports', disabled: true,
    })
    expect(rows.find(row => row.id === 'fantasy-weekly-reports')).not.toHaveProperty('config')
    for (const [id, name] of [['camera-ring', '@deepseek-ai/dsh-camera-ring'], ['camera-watch', '@deepseek-ai/dsh-camera-watch'],
      ['signal-cli', '@deepseek-ai/dsh-signal-cli'], ['signal-notices', '@deepseek-ai/dsh-signal-notices']]) {
      expect(rows.find(row => row.id === id)).toMatchObject({ name, disabled: true })
      expect(rows.find(row => row.id === id)).not.toHaveProperty('config')
    }
    expect(rows.find(row => row.id === 'local-model-control')).toMatchObject({
      name: '@deepseek-ai/dsh-local-model-control', disabled: true,
    })
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-fantasy-yahoo')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-tool-fantasy')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-fantasy-reports')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-local-model-control')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-session-query-sqlite')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-tool-session-query')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-web-search-searxng')
    for (const name of [
      '@deepseek-ai/dsh-tool-weather', '@deepseek-ai/dsh-log-exporter',
      '@deepseek-ai/dsh-tool-homelab',
      '@deepseek-ai/dsh-subagent-dsh-sdk',
      '@deepseek-ai/dsh-camera', '@deepseek-ai/dsh-camera-ring', '@deepseek-ai/dsh-camera-watch',
      '@deepseek-ai/dsh-signal', '@deepseek-ai/dsh-signal-cli', '@deepseek-ai/dsh-signal-notices',
    ]) expect(manifest.dependencies).toHaveProperty(name)
    expect(manifest.dependencies).not.toHaveProperty('@deepseek-ai/dsh-experimental-training-export')
  })

  it('declares Beardy in the profile preset layer with its memory instruction sources', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const presetPath = resolve(root, 'presets/beardy.patch.yml')
    const parsed: unknown = yaml.load(readFileSync(presetPath, 'utf8'), { schema: entryListSchema })
    expect(Array.isArray(parsed)).toBe(true)
    const first: unknown = Array.isArray(parsed) ? (parsed as unknown[])[0] : undefined
    if (!isRecord(first) || !Array.isArray(first.insert)) {
      throw new TypeError('Beardy preset must contain an entry list')
    }
    const declaration: unknown = (first.insert as unknown[]).find(value => isRecord(value) && value.id === 'preset-beardy')
    if (!isRecord(declaration) || !isRecord(declaration.config) || !Array.isArray(declaration.config.plugins)) {
      throw new TypeError('Beardy preset declaration must contain plugins')
    }
    expect(declaration.config).toMatchObject({ id: 'beardy', picker: 'main' })
    const instructions: unknown = declaration.config.plugins.find(value => isRecord(value) && value.id === 'agent-instructions')
    if (!isRecord(instructions) || !isRecord(instructions.config)) throw new TypeError('agent-instructions row config')
    expect(instructions.config.userGlobalInstructionCandidates)
      .toEqual(['AGENTS.md', 'SOUL.md', 'USER.md', 'MEMORY.md'])
    expect(instructions.config.frozenUserGlobalInstructionCandidates)
      .toEqual(['USER.md', 'MEMORY.md'])
    const rows = declaration.config.plugins.filter(isRecord)
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'tool-memory', name: '@deepseek-ai/dsh-tool-memory' }),
    ]))
  })
})
