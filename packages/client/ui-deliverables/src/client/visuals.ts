/** Conversation visuals derive exclusively from committed delivery snapshots. */
import type { ConversationLocation, ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { PresentedVisual } from '@deepseek-ai/dsh-tool-present/types'
import { isPresentedData, isPresentedFile } from '../presented.ts'

interface VisualFile {
  readonly path: string
  readonly description?: string
  readonly visual: PresentedVisual
}

interface VisualState {
  readonly files: VisualFile[]
  readonly anchorSeq: number
  readonly location: ConversationLocation
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** Original visual bytes and findings published during a turn. */
    'presented-visual': { readonly files: readonly VisualFile[] }
  }
}

const mediaTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'text/html'])

/**
 * Narrow a saved declaration without trusting its optional visual payload.
 * @param file - unvalidated Session file declaration.
 * @returns complete visual data, or null for ordinary or malformed declarations.
 */
export function visualFile(file: unknown): VisualFile | null {
  if (!isPresentedFile(file)) return null
  const visual: unknown = file.visual
  if (typeof visual !== 'object' || visual === null || Array.isArray(visual)) return null
  const { title, mediaType, data } = visual as Record<string, unknown>
  if (typeof title !== 'string' || !title.trim() || typeof mediaType !== 'string' || !mediaTypes.has(mediaType)
    || typeof data !== 'string' || !data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) return null
  return {
    path: file.path, ...file.description === undefined ? {} : { description: file.description },
    visual: { title, mediaType: mediaType as PresentedVisual['mediaType'], data },
  }
}

/** One immutable delivery is one Chat node, independent of tool dispatch mode and turn completion. */
export const visualsDefinition: ConversationNodeDefinition<VisualState> = {
  kind: 'presented-visual',
  target: 'chat',
  match: event => event.type === 'deliverables/presented' && isPresentedData(event.data)
    && event.data.files.some(file => visualFile(file) !== null)
    ? { id: String(event.seq), role: 'start' } : null,
  start: (_context, match) => {
    const event = match.event as SessionEvent<'deliverables/presented'>
    return { anchorSeq: event.seq, location: match.location, files: event.data.files.flatMap((file) => {
      const visual = visualFile(file)
      return visual === null ? [] : [visual]
    }) }
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined ? null : {
    key: context.key, id: context.id, kind: 'presented-visual', target: 'chat',
    anchorSeq: context.state.anchorSeq,
    location: context.state.location,
    visibility: 'visible', processDisclosure: 'independent', data: { files: context.state.files },
  },
}

/**
 * Decode a self-contained mockup beneath a restrictive policy in an opaque iframe.
 * @param base64 - saved UTF-8 HTML, validated again at the browser boundary.
 * @returns a complete srcdoc document; malformed encoding returns null.
 */
export function mockupDocument(base64: string): string | null {
  let html: string
  try {
    html = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(base64), char => char.charCodeAt(0)))
  } catch {
    // Malformed persisted base64 or UTF-8 cannot become an executable document.
    return null
  }
  return '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" '
    + 'content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; '
    + 'img-src data: blob:; font-src data:; media-src data: blob:; connect-src \'none\'; '
    + 'object-src \'none\'; frame-src \'none\'; base-uri \'none\'; form-action \'none\'">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">' + html
}
