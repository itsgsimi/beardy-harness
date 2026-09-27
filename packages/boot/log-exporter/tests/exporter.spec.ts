import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type LoggerType, type Message } from '@deepseek-ai/cordis'
import * as Exporter from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

function message(type: LoggerType, args: unknown[], name = 'gateway'): Message {
  return { sn: 1, ts: 0, type, level: 3, name, args }
}

const config: Exporter.Config = {
  levels: ['error', 'warn', 'info'],
  loggerNames: ['selected'],
  messagePrefixes: ['dsh-cron:'],
  lifecycleLines: [
    { exact: 'discord-gateway: mounted but disabled by configuration', output: 'discord-gateway: disabled' },
    { prefix: 'discord-gateway: listener stopped and will not retry:', output: 'discord-gateway: listener stopped' },
    { prefix: 'discord-gateway:', suffix: '; reconnecting', output: 'discord-gateway: reconnecting' },
  ],
  redactionPatterns: [
    { pattern: '(bearer\\s+)[^\\s"\']+', ignoreCase: true, replacement: '$1<redacted>' },
    { pattern: '\\b(sk|xox[abp]|ghp|gho)[-_][A-Za-z0-9_-]{10,}', ignoreCase: true, replacement: '<redacted>' },
    { pattern: '((?:api[-_]?key|token|secret|password)["\']?\\s*[:=]\\s*["\']?)[^\\s"\',}]+', ignoreCase: true, replacement: '$1<redacted>' },
  ],
  maxLineLength: 2000,
}

function withConfig(overrides: Exporter.Config): Exporter.Config {
  return Object.assign({}, config, overrides)
}

describe('journal selection', () => {
  it('maps lifecycle lines and exports cron lines while filtering other info and debug', () => {
    expect(Exporter.formatLogLines(message('info', [
      'discord-gateway: mounted but disabled by configuration',
      'discord-gateway: listener stopped and will not retry: private detail',
      'discord-gateway: transport dropped; reconnecting',
      'dsh-cron: run finished',
      'irrelevant',
    ]), config)).toEqual([
      'discord-gateway: disabled',
      'discord-gateway: listener stopped',
      'discord-gateway: reconnecting',
      'dsh-cron: run finished',
    ])
    expect(Exporter.formatLogLines(message('debug', ['dsh-cron: trace']), config)).toEqual([])
    expect(Exporter.formatLogLines(message('info', ['an event'], 'selected'), config)).toEqual(['info [selected] an event'])
    expect(Exporter.formatLogLines(message('info', [{ ready: true }], 'selected'), config))
      .toEqual(['info [selected] {"ready":true}'])
    expect(Exporter.formatLogLines(message('info', ['unselected'], 'other'), config)).toEqual([])
  })

  it('always includes configured warnings and errors, redacts before truncation, and prevents newlines', () => {
    const short = withConfig({ maxLineLength: 44 })
    const [warn] = Exporter.formatLogLines(message('warn', [
      'Bearer abcdefghijkl\napi_key=secret123', new Error('x'), { password: 'raw' },
    ]), short)
    expect(warn).toBe('warn [gateway] Bearer <redacted> api_key=<r…')
    expect(Exporter.formatLogLines(message('error', ['token=abc123', 'ghp_abcdefghijklmnop']), config)[0])
      .toContain('token=<redacted> <redacted>')
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(Exporter.formatLogLines(message('warn', [circular]), config)[0]).toContain('[unserializable]')
    expect(Exporter.formatLogLines(message('warn', [{ toJSON: () => undefined }]), config)[0])
      .toContain('[unserializable]')
  })

  it('applies configured severity and avoids mapping a merely similar lifecycle line', () => {
    const onlyInfo = withConfig({ levels: ['info'] })
    expect(Exporter.formatLogLines(message('warn', ['warning']), onlyInfo)).toEqual([])
    expect(Exporter.formatLogLines(message('info', ['discord-gateway: disconnected']), onlyInfo)).toEqual([])
    expect(Exporter.formatLogLines(message('info', ['x'], 'selected'), onlyInfo)).toEqual(['info [selected] x'])
  })

  it('uses safe defaults and prints unusual warning arguments', () => {
    expect(Exporter.formatLogLines(message('warn', [undefined, null, 3]), {}))
      .toEqual(['warn [gateway] undefined null 3'])
    expect(Exporter.formatLogLines(message('info', [42, 'ordinary']), {})).toEqual([])
    expect(Exporter.formatLogLines(message('info', ['ABC']), {
      messagePrefixes: ['ABC'], redactionPatterns: [{ pattern: 'ABC', replacement: 'x' }],
    })).toEqual(['x'])
  })

  it.each([
    [withConfig({ levels: [] }), 'levels'],
    [withConfig({ levels: ['warn', 'warn'] }), 'levels'],
    [withConfig({ maxLineLength: 1.5 }), 'maxLineLength'],
    [withConfig({ loggerNames: [' '] }), 'loggerNames'],
    [withConfig({ messagePrefixes: [''] }), 'messagePrefixes'],
    [withConfig({ lifecycleLines: [{ output: 'x' }] }), 'lifecycleLines'],
    [withConfig({ lifecycleLines: [{ exact: 'x', prefix: 'x', output: 'x' }] }), 'lifecycleLines'],
    [withConfig({ lifecycleLines: [{ prefix: 'x', suffix: '', output: 'x' }] }), 'lifecycleLines'],
    [withConfig({ lifecycleLines: [{ exact: 'x', output: 'x\ny' }] }), 'lifecycleLines'],
    [withConfig({ lifecycleLines: [{ exact: '', output: 'x' }] }), 'lifecycleLines'],
    [withConfig({ lifecycleLines: [{ prefix: '', output: 'x' }] }), 'lifecycleLines'],
    [withConfig({ lifecycleLines: [{ prefix: 'x', suffix: 'y', output: '' }] }), 'lifecycleLines'],
    [withConfig({ lifecycleLines: [{ prefix: 'x', suffix: 'y', output: 'x\ry' }] }), 'lifecycleLines'],
    [withConfig({ redactionPatterns: [{ pattern: '', replacement: 'x' }] }), 'redactionPatterns'],
    [withConfig({ redactionPatterns: [{ pattern: '(', replacement: 'x' }] }), 'invalid redaction'],
    [withConfig({ redactionPatterns: [{ pattern: 'x', replacement: 'x\ny' }] }), 'redactionPatterns'],
    [withConfig({ redactionPatterns: [{ pattern: 'x', replacement: 'x\ry' }] }), 'redactionPatterns'],
  ] satisfies [Exporter.Config, string][])('rejects invalid config before output', (value, detail) => {
    expect(() => Exporter.formatLogLines(message('info', ['hello']), value)).toThrow(detail)
  })

  it('attaches a Cordis exporter and removes it at disposal', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const count = ctx.logger.exporters.size
    const fiber = await ctx.plugin(Exporter, config)
    ctx.logger('some-service').warn('Bearer topsecret')
    expect(write).toHaveBeenCalledWith('warn [some-service] Bearer <redacted>\n')
    await fiber.dispose()
    expect(ctx.logger.exporters.size).toBe(count)
  })
})
