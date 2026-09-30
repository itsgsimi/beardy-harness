/**
 * Caller identity, workspace authorization, and visible lineage projection.
 *
 * @module @deepseek-ai/dsh-tool-session-query/workspace-access
 */

import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import {
  type SessionHeader,
  type SessionId as SessionIdValue,
} from '@deepseek-ai/dsh-session'
import type { TurnBoundaryProjection } from '@deepseek-ai/dsh-agent'
import type {
  SessionLineageNode,
  SessionRecord,
} from '@deepseek-ai/dsh-session-query'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-projection'
import { serviceBoundary } from './service-boundary.ts'

/**
 * Normalized workspace aliases: each caller workspace maps to the additional workspaces whose Sessions it may
 * search and read. Keys and values are absolute, resolved paths without trailing separators.
 */
export type WorkspaceAliases = ReadonlyMap<string, readonly string[]>

interface Caller {
  readonly id: SessionIdValue
  readonly header: SessionHeader
  /** The caller's workspace followed by its aliases; empty when the caller Session has no workspace. */
  readonly workspaces: readonly string[]
  /** The caller's own-session boundary fold (the `turnBoundary` projection). */
  readonly boundary: TurnBoundaryProjection | undefined
}

interface TitleView {
  readonly text: string
  readonly unavailableCode?: string
}

interface CompleteTitleMap extends ReadonlyMap<SessionIdValue, TitleView> {
  get(id: SessionIdValue): TitleView
}

interface AuthorizedDescendant {
  readonly record: SessionRecord
  readonly descendants: Array<AuthorizedDescendant | null>
}

interface DescendantProjectionFrame {
  readonly node: SessionLineageNode
  readonly target: Array<AuthorizedDescendant | null>
  readonly next: DescendantProjectionFrame | undefined
}

interface DescendantVisit {
  readonly node: AuthorizedDescendant | null
  readonly depth: number
  readonly next: DescendantVisit | undefined
}

function normalizeWorkspace(path: string, field: string): string {
  if (!isAbsolute(path)) {
    throw new TypeError(`tool-session-query: ${field} must be an absolute path, got ${JSON.stringify(path)}`)
  }
  return resolve(path)
}

/**
 * Validate and normalize configured workspace aliases.
 *
 * @param config - Raw `workspaceAliases` config keyed by caller workspace.
 * @returns Normalized aliases keyed by normalized caller workspace.
 * @throws {TypeError} When a key or alias is relative, a key or an alias repeats after normalization, or a
 *   workspace aliases itself.
 */
function resolveWorkspaceAliases(config: Readonly<Record<string, readonly string[]>>): WorkspaceAliases {
  const result = new Map<string, readonly string[]>()
  for (const [rawWorkspace, rawAliases] of Object.entries(config)) {
    const workspace = normalizeWorkspace(rawWorkspace, 'workspaceAliases key')
    if (result.has(workspace)) {
      throw new TypeError(`tool-session-query: workspaceAliases repeats workspace ${JSON.stringify(workspace)}`)
    }
    const aliases: string[] = []
    for (const rawAlias of rawAliases) {
      const alias = normalizeWorkspace(rawAlias, `workspaceAliases[${JSON.stringify(workspace)}] entry`)
      if (alias === workspace) {
        throw new TypeError(`tool-session-query: workspace ${JSON.stringify(workspace)} must not alias itself`)
      }
      if (aliases.includes(alias)) {
        throw new TypeError(
          `tool-session-query: workspaceAliases[${JSON.stringify(workspace)}] repeats ${JSON.stringify(alias)}`,
        )
      }
      aliases.push(alias)
    }
    result.set(workspace, aliases)
  }
  return result
}

function callerOf(exec: ToolRunContext, ctx: Context, aliases: WorkspaceAliases): Caller {
  const agent = exec.agent
  if (agent === undefined) {
    throw new HarnessError(
      'session query tools require an agent-bound caller',
      'SESSION_QUERY_TOOL_MISSING_AGENT',
    )
  }
  const cwd = agent.session.header.cwd
  return {
    id: agent.session.id,
    header: agent.session.header,
    workspaces: cwd === undefined ? [] : [cwd, ...aliases.get(resolve(cwd)) ?? []],
    boundary: ctx.sessionProjections.stateOf(agent.session, 'turnBoundary'),
  }
}

function targetId(args: { readonly session_id?: string }, caller: Caller): SessionIdValue {
  return args.session_id === undefined ? caller.id : brandString<SessionIdValue>(args.session_id)
}

async function authorizeTarget(
  ctx: Context,
  caller: Caller,
  target: SessionIdValue,
  signal: AbortSignal,
): Promise<void> {
  if (target === caller.id) return
  if (caller.workspaces.length === 0) throw serviceBoundary.unauthorizedTarget()
  const records = await serviceBoundary.call(ctx, signal, 'target authorization', () =>
    ctx.sessionQuery.filterSessions([
      { kind: 'id', values: [target] },
      { kind: 'cwd', values: [...caller.workspaces] },
    ], signal))
  if (records.length !== 1) throw serviceBoundary.unauthorizedTarget()
}

function recordAuthorized(record: SessionRecord, caller: Caller): boolean {
  return headerAuthorized(record.header, caller)
}

function headerAuthorized(header: SessionHeader, caller: Caller): boolean {
  if (header.id === caller.id) return header.cwd === caller.header.cwd
  return header.cwd !== undefined && caller.workspaces.includes(header.cwd)
}

function assertObservedTargetAuthorized(
  caller: Caller,
  target: SessionIdValue,
  observed: SessionHeader,
): void {
  if (observed.id !== target || !headerAuthorized(observed, caller)) {
    throw serviceBoundary.unauthorizedTarget()
  }
}

async function authorizeSessionIds(
  ctx: Context,
  caller: Caller,
  ids: readonly SessionIdValue[],
  signal: AbortSignal,
): Promise<ReadonlySet<SessionIdValue>> {
  const unique = [...new Set(ids)]
  const authorized = new Set<SessionIdValue>()
  if (unique.includes(caller.id)) authorized.add(caller.id)
  const other = unique.filter(id => id !== caller.id)
  if (caller.workspaces.length === 0 || other.length === 0) return authorized
  const records = await serviceBoundary.call(ctx, signal, 'session-id authorization', () =>
    ctx.sessionQuery.filterSessions([
      { kind: 'id', values: other },
      { kind: 'cwd', values: [...caller.workspaces] },
    ], signal))
  const requested = new Set(other)
  for (const record of records) {
    if (requested.has(record.header.id) && recordAuthorized(record, caller)) {
      authorized.add(record.header.id)
    }
  }
  return authorized
}

async function readTitles(
  ctx: Context,
  caller: Caller,
  ids: readonly SessionIdValue[],
  signal: AbortSignal,
): Promise<CompleteTitleMap> {
  const result = new Map<SessionIdValue, TitleView>()
  const observations = await serviceBoundary.call(ctx, signal, 'title observation', () =>
    ctx.sessionQuery.readTitleSnapshots(ids, signal))
  for (const observation of observations) {
    if (observation.status === 'rejected') {
      result.set(observation.sessionId, unavailableTitle(ctx, observation.reason))
      continue
    }
    assertObservedTargetAuthorized(caller, observation.sessionId, observation.value.session)
    result.set(observation.sessionId, { text: observation.value.title?.title ?? 'untitled' })
  }
  return result as CompleteTitleMap
}

async function readTitle(
  ctx: Context,
  caller: Caller,
  id: SessionIdValue,
  signal: AbortSignal,
): Promise<TitleView> {
  return (await readTitles(ctx, caller, [id], signal)).get(id)
}

function unavailableTitle(
  ctx: Context,
  error: unknown,
): TitleView {
  const sanitized = serviceBoundary.sanitizeError(ctx, 'title observation item', error)
  if (sanitized.code === 'SESSION_QUERY_TOOL_UNAUTHORIZED') throw sanitized
  return { text: 'untitled', unavailableCode: sanitized.code }
}

function authorizeDescendants(
  nodes: readonly SessionLineageNode[],
  caller: Caller,
): Array<AuthorizedDescendant | null> {
  const result: Array<AuthorizedDescendant | null> = []
  let pending: DescendantProjectionFrame | undefined
  for (const node of [...nodes].reverse()) {
    pending = { node, target: result, next: pending }
  }
  while (pending !== undefined) {
    const current = pending
    pending = current.next
    if (!recordAuthorized(current.node.session, caller)) {
      current.target.push(null)
      continue
    }
    const projected: AuthorizedDescendant = {
      record: current.node.session,
      descendants: [],
    }
    current.target.push(projected)
    for (const child of [...current.node.descendants].reverse()) {
      pending = {
        node: child,
        target: projected.descendants,
        next: pending,
      }
    }
  }
  return result
}

function * visitDescendants(
  nodes: readonly (AuthorizedDescendant | null)[],
): Generator<DescendantVisit> {
  let pending: DescendantVisit | undefined
  for (const node of [...nodes].reverse()) {
    pending = { node, depth: 0, next: pending }
  }
  while (pending !== undefined) {
    const current = pending
    pending = current.next
    yield current
    if (current.node === null) continue
    for (const child of [...current.node.descendants].reverse()) {
      pending = {
        node: child,
        depth: current.depth + 1,
        next: pending,
      }
    }
  }
}

function descendantIds(nodes: readonly (AuthorizedDescendant | null)[]): SessionIdValue[] {
  const ids: SessionIdValue[] = []
  for (const { node } of visitDescendants(nodes)) {
    if (node !== null) ids.push(node.record.header.id)
  }
  return ids
}

function titleText(view: TitleView): string {
  return view.unavailableCode === undefined
    ? view.text
    : `${view.text} (title unavailable: ${view.unavailableCode})`
}

/** Workspace-scoped caller authorization, alias resolution, title access, and lineage projection. */
export const workspaceAccess = {
  resolveWorkspaceAliases,
  callerOf,
  targetId,
  authorizeTarget,
  recordAuthorized,
  assertObservedTargetAuthorized,
  authorizeSessionIds,
  readTitles,
  readTitle,
  authorizeDescendants,
  visitDescendants,
  descendantIds,
  titleText,
}
