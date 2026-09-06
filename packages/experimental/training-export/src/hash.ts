/**
 * SHA-256 digests and canonical (sorted-key, no-whitespace) JSON for the
 * spec's `hashes.system` / `hashes.tools` fields.
 * @module @deepseek-ai/dsh-experimental-training-export/hash
 */

import { createHash } from 'node:crypto'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

/**
 * Hash UTF-8 text, prefixed `sha256:` per the format spec's examples.
 * @param text - the exact text to digest.
 * @returns `sha256:<hex digest>`.
 */
export function sha256Hex(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

/** Recursively sort every plain object's keys; arrays keep their order. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

/**
 * Serialize a value as canonical JSON: keys sorted at every level, no
 * whitespace (the default `JSON.stringify` separators already carry none).
 * @param value - the JSON-serializable value to canonicalize.
 * @returns the canonical JSON text.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value))
}

/**
 * `hashes.system`: over the UTF-8 system string, or `""` when the request
 * carries none.
 * @param system - the request's optional system prompt text.
 * @returns `sha256:<hex digest>`.
 */
export function hashSystem(system: string | undefined): string {
  return sha256Hex(system ?? '')
}

/**
 * `hashes.tools`: over the canonical JSON of the request's tool schemas, or
 * `[]` when the request carries none.
 * @param tools - the request's optional tool schemas.
 * @returns `sha256:<hex digest>`.
 */
export function hashTools(tools: ToolSchema[] | undefined): string {
  return sha256Hex(canonicalJson(tools ?? []))
}
