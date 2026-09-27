/** Durable source-file declarations and visual snapshots produced by delivery tools. */
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'

/** A source-file declaration with optional saved visual bytes for display. */
export interface PresentedFile {
  /** Original absolute path or path relative to the Session working directory. */
  path: string
  /** Optional description supplied by the model. */
  description?: string
  /** Immutable visual snapshot for inline chat; absent for ordinary file delivery. */
  visual?: PresentedVisual
}

/** Display-only bytes retained in the Session, never projected into model messages. */
export interface PresentedVisual {
  /** Human-readable heading and image alternative text. */
  title: string
  /** Browser rendering mode selected from the supported file extension. */
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/svg+xml' | 'text/html'
  /** Canonical base64 of the original file, preserving animation and vector content. */
  data: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Source files and optional visual snapshots from successful final delivery results, including nested calls. */
    'deliverables/presented': { turn: number; callId: ToolCallId; files: PresentedFile[] }
  }
}
