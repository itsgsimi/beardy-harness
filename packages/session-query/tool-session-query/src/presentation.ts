/**
 * Model text rendering and generic tool-call presentation.
 *
 * @module @deepseek-ai/dsh-tool-session-query/presentation
 */

import {
  extractSessionEventText,
  type SessionEventSearchHit,
  type SessionEventTraceObservation,
  type SessionEventWindow,
  type SessionLineageTrace,
  type SessionRecord,
  type SessionSearchHit,
  sessionRecallOrigin,
} from '@deepseek-ai/dsh-session-query'
import type {
  SessionEvent,
  SessionId,
} from '@deepseek-ai/dsh-session'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { workspaceAccess } from './workspace-access.ts'

type TitleView = Awaited<ReturnType<typeof workspaceAccess.readTitle>>
type CompleteTitleMap = Awaited<ReturnType<typeof workspaceAccess.readTitles>>
type AuthorizedDescendants = ReturnType<typeof workspaceAccess.authorizeDescendants>

interface SearchCollection<T> {
  readonly items: T[]
  readonly capped: boolean
}

interface SessionSearchCallArgs {
  readonly query?: string
  readonly view?: 'search' | 'recent'
}

interface EventSearchCallArgs {
  readonly query: string
}

interface SessionTargetCallArgs {
  readonly session_id?: string
}

interface EventTargetCallArgs extends SessionTargetCallArgs {
  readonly seq: number
}

function formatSessionSearch(
  collected: SearchCollection<SessionSearchHit>,
  titles: CompleteTitleMap,
  authorizedParents: ReadonlySet<SessionId>,
  callerWorkspace: string,
): string {
  if (collected.items.length === 0) return formatEmptySessionSearch('search')
  const lines = [`Session search results (${collected.items.length}):`]
  for (const [index, hit] of collected.items.entries()) {
    lines.push(
      '',
      ...sessionLines(index, hit, titles, authorizedParents, callerWorkspace),
      `   Best match: seq ${hit.bestMatch.seq} | ${hit.bestMatch.type} | ${hit.bestMatch.surface} | ${formatTime(hit.bestMatch.time)}`,
      `   Snippet: ${hit.bestMatch.snippet}`,
    )
  }
  if (collected.capped) {
    lines.push('', 'Result cap reached. Narrow the query or add filters to find additional matches.')
  }
  return lines.join('\n')
}

function formatRecentSessions(
  collected: SearchCollection<SessionRecord>,
  titles: CompleteTitleMap,
  authorizedParents: ReadonlySet<SessionId>,
  callerWorkspace: string,
): string {
  if (collected.items.length === 0) return formatEmptySessionSearch('recent')
  const lines = [`Recent sessions, newest first (${collected.items.length}):`]
  for (const [index, record] of collected.items.entries()) {
    lines.push('', ...sessionLines(index, record, titles, authorizedParents, callerWorkspace))
  }
  if (collected.capped) {
    lines.push('', 'Result cap reached. Set created_at_to before the oldest listed creation time to list older sessions.')
  }
  return lines.join('\n')
}

function sessionLines(
  index: number,
  record: SessionRecord,
  titles: CompleteTitleMap,
  authorizedParents: ReadonlySet<SessionId>,
  callerWorkspace: string,
): string[] {
  const parent = record.header.parentSession === undefined
    ? 'root'
    : authorizedParents.has(record.header.parentSession)
      ? record.header.parentSession
      : '[outside workspace]'
  // Only an aliased workspace hit differs from the caller workspace; same-workspace hits omit the line.
  const workspace = record.header.cwd === callerWorkspace ? [] : [`   Workspace: ${record.header.cwd}`]
  return [
    `${index + 1}. Session ${record.header.id} — ${workspaceAccess.titleText(titles.get(record.header.id))}`,
    `   Created: ${formatTime(record.header.createdAt)}`,
    ...workspace,
    `   Origin: ${sessionRecallOrigin(record.header)}`,
    `   Parent: ${parent}`,
    `   Availability: ${availabilityText(record)}`,
  ]
}

function formatEmptySessionSearch(view: 'search' | 'recent'): string {
  return view === 'recent' ? 'No prior sessions found.' : 'No prior session matches found.'
}

function formatEventSearch(
  sessionId: SessionId,
  title: TitleView,
  collected: SearchCollection<SessionEventSearchHit>,
): string {
  const lines = [`Session ${sessionId} — ${workspaceAccess.titleText(title)}`]
  if (collected.items.length === 0) {
    lines.push('', 'No prior event matches found.')
    return lines.join('\n')
  }
  lines.push('', `Event search results (${collected.items.length}):`)
  for (const [index, hit] of collected.items.entries()) {
    lines.push(
      `${index + 1}. seq ${hit.seq} | ${hit.type} | ${hit.surface} | ${formatTime(hit.time)}`,
      `   Snippet: ${hit.snippet}`,
    )
  }
  if (collected.capped) {
    lines.push('', 'Result cap reached. Narrow the query or add filters to find additional matches.')
  }
  return lines.join('\n')
}

function formatSessionTrace(
  trace: SessionLineageTrace,
  ancestors: readonly SessionRecord[],
  ancestorBoundary: boolean,
  descendants: AuthorizedDescendants,
  titles: CompleteTitleMap,
): string {
  const lines = [
    `Session ${trace.target.header.id} — ${workspaceAccess.titleText(titles.get(trace.target.header.id))}`,
    `Created: ${formatTime(trace.target.header.createdAt)}`,
    `Availability: ${availabilityText(trace.target)}`,
    '',
    'Ancestors (nearest first):',
  ]
  if (ancestors.length === 0 && !ancestorBoundary) lines.push('- none (target is a root session)')
  for (const record of ancestors) {
    lines.push(`- ${record.header.id} — ${workspaceAccess.titleText(titles.get(record.header.id))} | ${formatTime(record.header.createdAt)} | ${availabilityText(record)}`)
  }
  if (ancestorBoundary) lines.push('- [outside workspace boundary]')
  lines.push('', 'Descendants:')
  if (descendants.length === 0) lines.push('- none')
  else renderDescendants(lines, descendants, titles)
  return lines.join('\n')
}

function renderDescendants(
  lines: string[],
  nodes: AuthorizedDescendants,
  titles: CompleteTitleMap,
): void {
  for (const { node, depth } of workspaceAccess.visitDescendants(nodes)) {
    const indent = '  '.repeat(depth)
    if (node === null) {
      lines.push(`${indent}- [outside workspace subtree]`)
      continue
    }
    const id = node.record.header.id
    lines.push(`${indent}- ${id} — ${workspaceAccess.titleText(titles.get(id))} | ${formatTime(node.record.header.createdAt)} | ${availabilityText(node.record)}`)
  }
}

function formatEventTrace(
  sessionId: SessionId,
  title: TitleView,
  trace: SessionEventTraceObservation,
): string {
  return [
    `Session ${sessionId} — ${workspaceAccess.titleText(title)}`,
    `Target: seq ${trace.target.seq} | ${trace.target.type} | ${trace.target.surface} | ${formatTime(trace.target.time)}`,
    `Replaced by: ${trace.replacedBy ?? 'none'}`,
    `Replacement chain: ${seqList(trace.replacementChain)}`,
    `Events replaced by target: ${seqList(trace.replacedEventSeqs)}`,
    `Events cited directly as sources: ${seqList(trace.sourceEventSeqs)}`,
    `Direct derived events: ${seqList(trace.derivedEventSeqs)}`,
  ].join('\n')
}

function formatEventRead(
  sessionId: SessionId,
  title: TitleView,
  window: SessionEventWindow,
): string {
  const before = window.events.filter(event => event.seq < window.target.seq)
  const after = window.events.filter(event => event.seq > window.target.seq)
  const lines = [
    `Session ${sessionId} — ${workspaceAccess.titleText(title)}`,
    `Target event seq ${window.target.seq}:`,
    '```json',
    JSON.stringify(window.target, null, 2),
    '```',
  ]
  if (before.length > 0) {
    lines.push('', 'Before:')
    for (const event of before) lines.push(formatNeighbor(event))
  }
  if (after.length > 0) {
    lines.push('', 'After:')
    for (const event of after) lines.push(formatNeighbor(event))
  }
  return lines.join('\n')
}

function formatNeighbor(event: SessionEvent): string {
  const text = extractSessionEventText(event)
  return `- seq ${event.seq} | ${event.type} | ${formatTime(event.time)}`
    + (text.length === 0 ? ' | (no semantic text)' : `\n  ${text.replaceAll('\n', '\n  ')}`)
}

function availabilityText(record: SessionRecord): string {
  return [
    record.live ? 'live' : undefined,
    record.persisted ? 'persisted' : undefined,
  ].filter((value): value is string => value !== undefined).join(', ') || 'unavailable'
}

function seqList(values: readonly number[]): string {
  return values.length === 0 ? 'none' : values.join(', ')
}

function formatTime(value: number): string {
  return new Date(value).toISOString()
}

function presentSessionSearchCall(args: SessionSearchCallArgs): GenericCallView {
  if (args.view === 'recent') return { card: 'generic', kind: 'search', title: 'List recent sessions' }
  return {
    card: 'generic',
    kind: 'search',
    title: 'Search prior sessions',
    ...args.query === undefined ? {} : { rawInput: args.query },
  }
}

function presentEventSearchCall(args: EventSearchCallArgs): GenericCallView {
  return { card: 'generic', kind: 'search', title: 'Search session events', rawInput: args.query }
}

function presentSessionTraceCall(args: SessionTargetCallArgs): GenericCallView {
  return {
    card: 'generic',
    kind: 'read',
    title: args.session_id === undefined ? 'Trace current session' : `Trace session ${args.session_id}`,
    ...args.session_id === undefined ? {} : { rawInput: args.session_id },
  }
}

function presentEventTargetCall(
  action: string,
  args: EventTargetCallArgs,
): GenericCallView {
  return {
    card: 'generic',
    kind: 'read',
    title: `${action} ${args.seq}`,
    rawInput: {
      ...args.session_id === undefined ? {} : { session_id: args.session_id },
      seq: args.seq,
    },
  }
}

/** Text output and call-card presentation for every session-query tool. */
export const presentation = {
  formatSessionSearch,
  formatRecentSessions,
  formatEmptySessionSearch,
  formatEventSearch,
  formatSessionTrace,
  formatEventTrace,
  formatEventRead,
  presentSessionSearchCall,
  presentEventSearchCall,
  presentSessionTraceCall,
  presentEventTargetCall,
}
