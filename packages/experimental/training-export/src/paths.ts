/**
 * On-disk layout for the training-export sidecar: `<root>/<session-id-escaped>/`
 * holding `samples.jsonl`, `labels.jsonl`, and `meta.json`. Session ids use the
 * JSONL persistence path encoder so sidecar and Session directories agree.
 * @module @deepseek-ai/dsh-experimental-training-export/paths
 */

import { join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { encodeSegment } from '@deepseek-ai/dsh-session-persistence-jsonl/path-segment'

export { encodeSegment } from '@deepseek-ai/dsh-session-persistence-jsonl/path-segment'

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
