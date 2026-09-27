/**
 * Selected Cordis log records to a line-oriented process journal. Filtering, lifecycle
 * normalization, redaction, and length bounds are deployment config; registrations unwind with
 * their Cordis fiber.
 * @module @deepseek-ai/dsh-log-exporter
 */

import type { Context, LoggerType, Message } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Cordis Loader name. */
export const name = 'log-exporter'

/** An exact lifecycle line or a prefix with an optional required suffix. */
export interface LifecycleLine {
  /** Exact input line; exclusive with prefix and suffix. */
  exact?: string
  /** Input prefix; may be paired with suffix. */
  prefix?: string
  /** Input suffix, only with prefix. */
  suffix?: string
  /** Stable output line, with variable input omitted. */
  output: string
}

/** A regular-expression replacement applied before writing a line. */
export interface RedactionPattern {
  /** JavaScript regular expression source. */
  pattern: string
  /** Case-insensitive matching when true; every match is replaced. */
  ignoreCase?: boolean
  /** Replacement text; use $1 for a retained capture. */
  replacement: string
}

/** Journal selection and formatting config. */
export interface Config {
  /** Logger severities eligible for export; defaults to error, warn, and info. */
  levels?: LoggerType[]
  /** Exact logger names selected beyond unconditional warnings and errors. */
  loggerNames?: string[]
  /** Message prefixes selected beyond unconditional warnings and errors. */
  messagePrefixes?: string[]
  /** Lifecycle lines mapped to stable output before the other info filters. */
  lifecycleLines?: LifecycleLine[]
  /** Ordered redactions applied to every emitted line. */
  redactionPatterns?: RedactionPattern[]
  /** Maximum characters in one written line, including an ellipsis when cut. */
  maxLineLength?: number
}

/** Cordis validates the field types; apply validates relationships and regex syntax. */
export const Config: z<Config> = z.object({
  levels: z.array(z.union(['error', 'warn', 'info', 'debug'])).default(['error', 'warn', 'info']),
  loggerNames: z.array(z.string()).default([]),
  messagePrefixes: z.array(z.string()).default([]),
  lifecycleLines: z.array(z.object({
    exact: z.string(), prefix: z.string(), suffix: z.string(), output: z.string().required(),
  })).default([]),
  redactionPatterns: z.array(z.object({
    pattern: z.string().required(), ignoreCase: z.boolean().default(false), replacement: z.string().required(),
  })).default([]),
  maxLineLength: z.number().min(1).default(2000),
})

interface ResolvedConfig {
  readonly levels: LoggerType[]
  readonly loggerNames: string[]
  readonly messagePrefixes: string[]
  readonly lifecycleLines: LifecycleLine[]
  readonly redactionPatterns: RedactionPattern[]
  readonly maxLineLength: number
}

function validate(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    levels: config.levels ?? ['error', 'warn', 'info'],
    loggerNames: config.loggerNames ?? [],
    messagePrefixes: config.messagePrefixes ?? [],
    lifecycleLines: config.lifecycleLines ?? [],
    redactionPatterns: config.redactionPatterns ?? [],
    maxLineLength: config.maxLineLength ?? 2000,
  }
  if (resolved.levels.length === 0 || new Set(resolved.levels).size !== resolved.levels.length) {
    throw new Error('log-exporter: levels must contain unique severities')
  }
  if (!Number.isSafeInteger(resolved.maxLineLength) || resolved.maxLineLength < 1) {
    throw new Error('log-exporter: maxLineLength must be a positive safe integer')
  }
  for (const [key, values] of [
    ['loggerNames', resolved.loggerNames], ['messagePrefixes', resolved.messagePrefixes],
  ] as const) {
    if (values.some(value => value.trim() === '')) {
      throw new Error(`log-exporter: ${key} entries must not be empty`)
    }
  }
  for (const line of resolved.lifecycleLines) {
    if (line.output.trim() === '' || line.output.includes('\n') || line.output.includes('\r')
      || (line.exact === undefined) === (line.prefix === undefined)
      || (line.suffix !== undefined && line.prefix === undefined)
      || line.exact === '' || line.prefix === '' || line.suffix === '') {
      throw new Error('log-exporter: lifecycleLines require one non-empty exact or prefix, optional suffix, and one-line output')
    }
  }
  for (const redaction of resolved.redactionPatterns) {
    if (redaction.pattern === '' || redaction.replacement.includes('\n') || redaction.replacement.includes('\r')) {
      throw new Error('log-exporter: redactionPatterns need a pattern and one-line replacement')
    }
    try {
      new RegExp(redaction.pattern, redaction.ignoreCase ? 'gi' : 'g')
    } catch {
      throw new Error(`log-exporter: invalid redaction pattern: ${redaction.pattern}`)
    }
  }
  return resolved
}

function printable(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (value === null || typeof value !== 'object') return String(value)
  try {
    const serialized: unknown = JSON.stringify(value)
    return typeof serialized === 'string' ? serialized : '[unserializable]'
  } catch {
    return '[unserializable]'
  }
}

function mappedLine(value: string, mappings: readonly LifecycleLine[]): string | undefined {
  return mappings.find(rule => rule.exact !== undefined
    ? value === rule.exact
    : value.startsWith(rule.prefix as string) && (rule.suffix === undefined || value.endsWith(rule.suffix)))?.output
}

/**
 * Format one structured log message into zero or more safe journal lines.
 * @param message - Cordis log record.
 * @param config - validated selection, redaction, and length policy.
 * @returns selected one-line strings, redacted before truncation.
 */
export function formatLogLines(message: Message, config: Config): string[] {
  const resolved = validate(config)
  if (!resolved.levels.includes(message.type)) return []
  const candidates: string[] = []
  if (message.type === 'warn' || message.type === 'error') {
    candidates.push(`${message.type} [${message.name}] ${message.args.map(printable).join(' ')}`)
  } else {
    for (const arg of message.args) {
      if (typeof arg !== 'string') continue
      const mapped = mappedLine(arg, resolved.lifecycleLines)
      if (mapped !== undefined) candidates.push(mapped)
      else if (resolved.messagePrefixes.some(prefix => arg.startsWith(prefix))) candidates.push(arg)
    }
    if (candidates.length === 0 && resolved.loggerNames.includes(message.name)) {
      candidates.push(`${message.type} [${message.name}] ${message.args.map(printable).join(' ')}`)
    }
  }
  const patterns = resolved.redactionPatterns.map(item =>
    ({ regex: new RegExp(item.pattern, item.ignoreCase ? 'gi' : 'g'), replacement: item.replacement }))
  return candidates.map((candidate) => {
    let line = candidate.replace(/[\r\n]+/g, ' ')
    for (const item of patterns) line = line.replace(item.regex, item.replacement)
    return line.length > resolved.maxLineLength
      ? `${line.slice(0, resolved.maxLineLength - 1)}…` : line
  })
}

/**
 * Attach a stdout exporter to the current Cordis fiber.
 * @param ctx - Cordis context whose logger owns the exporter.
 * @param config - validated filtering and redaction choices.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = validate(config)
  ctx.logger.exporter({
    levels: { default: 3 },
    export(message) {
      for (const line of formatLogLines(message, resolved)) process.stdout.write(line + '\n')
    },
  })
}
