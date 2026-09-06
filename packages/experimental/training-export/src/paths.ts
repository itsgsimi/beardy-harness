/**
 * On-disk layout for the training-export sidecar: `<root>/<session-id-escaped>/`
 * holding `samples.jsonl`, `labels.jsonl`, and `meta.json`. The id-escape
 * mirrors `dsh-session-persistence-jsonl`'s `encodeSegment` (same injective
 * code-unit escape), reimplemented locally so this plugin does not depend on
 * a concrete persistence backend for one path-safety helper.
 * @module @deepseek-ai/dsh-experimental-training-export/paths
 */

import { join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'

/**
 * Encode an arbitrary string as one safe path segment, injective over all
 * JS (UTF-16) strings including lone surrogates. A {@link SessionId} is an
 * unvalidated branded string, so it MUST be encoded before filesystem use —
 * this neutralizes `../`, absolute paths, NUL, and separators. Safe code
 * units stay literal; every other unit, including `~`, becomes `~XXXX`.
 * @param raw - the string to encode; must be non-empty.
 * @returns the escaped single path segment.
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('training-export: cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * The directory this plugin owns for one session's sidecar artifacts.
 * @param root - the plugin's configured root directory.
 * @param sessionId - the session whose sidecar directory this resolves.
 * @returns `<root>/<sessionId-escaped>`.
 */
export function sessionDir(root: string, sessionId: SessionId): string {
  return join(root, encodeSegment(sessionId))
}

/**
 * Path to the session's append-only `train/sample` log.
 * @param dir - the session's sidecar directory, from {@link sessionDir}.
 * @returns `<dir>/samples.jsonl`.
 */
export function samplesPath(dir: string): string {
  return join(dir, 'samples.jsonl')
}

/**
 * Path to the session's append-only `train/label` log.
 * @param dir - the session's sidecar directory, from {@link sessionDir}.
 * @returns `<dir>/labels.jsonl`.
 */
export function labelsPath(dir: string): string {
  return join(dir, 'labels.jsonl')
}

/**
 * Path to the session's once-written metadata file.
 * @param dir - the session's sidecar directory, from {@link sessionDir}.
 * @returns `<dir>/meta.json`.
 */
export function metaPath(dir: string): string {
  return join(dir, 'meta.json')
}
