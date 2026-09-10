/** Publish bounded, immutable visual files after the guarded tool result succeeds. */
import { extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import type { PresentedFile, PresentedVisual } from './types.ts'

const mediaTypes: Readonly<Record<string, PresentedVisual['mediaType']>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.html': 'text/html', '.htm': 'text/html',
}

/**
 * Register the visual publisher alongside ordinary file delivery.
 * @param ctx - scoped filesystem, tool and turn-projection services.
 * @param maxBytes - complete serialized delivery budget, including base64 expansion.
 * @param stage - retain a candidate until the final tools/result notification.
 */
export function registerVisualTool(
  ctx: Context,
  maxBytes: number,
  stage: (exec: ToolExecution, delivery: { session: Session; turn: number; files: PresentedFile[] }) => void,
): void {
  ctx.tools.register(defineTool({
    name: 'present_visual',
    description: 'Show a saved screenshot, chart, animated GIF, SVG diagram, or self-contained HTML/CSS/JavaScript mockup directly in the conversation with your findings. '
      + 'When data is clearer as a chart, show the chart alongside your text explanation. Use visuals during browser testing and whenever they explain the work better than prose. Create the file first, then call this tool. '
      + 'PNG, JPEG, WebP, GIF, SVG and UTF-8 HTML are supported. Embed all mockup assets; external resources are blocked. '
      + 'A snapshot is preserved for the user. This tool displays the file but does not inspect its contents for you.',
    parameters: {
      path: { type: 'string', required: true, description: 'Existing visual file, absolute or relative to the working directory.' },
      title: { type: 'string', required: true, description: 'Short title describing the visual; also used as image alternative text.' },
      description: { type: 'string', required: true, description: 'Findings or explanation to display beside the visual.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          title: { type: 'string', required: true },
          mediaType: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Presented visual: ${value.title} (${value.path})` }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('present_visual requires an agent Session')
      const session = exec.agent.session
      const boundary = ctx.sessionProjections.stateOf(session, 'turnBoundary')
      if (boundary === undefined || boundary.openTurnStartSeq === null) throw new Error('present_visual requires an open turn')
      const cwd = session.header.cwd
      if (cwd === undefined) throw new Error('present_visual requires a workspace')
      if (![args.path, args.title, args.description].every(value => value.trim().length > 0)) {
        throw new Error('present_visual requires non-empty path, title, and description')
      }
      const mediaType = mediaTypes[extname(args.path).toLowerCase()]
      if (mediaType === undefined) throw new Error('present_visual accepts PNG, JPEG, WebP, GIF, SVG, and HTML files')
      const entry = await ctx.fs.lstat(args.path, { cwd }, exec.signal)
      if (entry !== undefined && entry.type !== 'file') throw new Error(`Cannot present ${args.path}: not a regular file`)
      const target = await ctx.fs.resolve(args.path, { cwd, signal: exec.signal })
      const info = await ctx.fs.stat(target, exec.signal)
      if (info?.type !== 'file') throw new Error(`Cannot present ${args.path}: file not found or not a regular file`)
      const bytes = await ctx.fs.readBytes(target, exec.signal, maxBytes)
      if (bytes.length === 0) throw new Error('present_visual cannot display an empty file')
      if (mediaType === 'text/html' || mediaType === 'image/svg+xml') {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      }
      const files: PresentedFile[] = [{
        path: args.path, description: args.description,
        visual: { title: args.title, mediaType, data: Buffer.from(bytes).toString('base64') },
      }]
      const event = { turn: boundary.lastTurn, callId: exec.callId, files }
      if (Buffer.byteLength(JSON.stringify(event)) > maxBytes) {
        throw new Error(`Visual delivery exceeds maxVisualBytes (${maxBytes}); reduce the file or description size`)
      }
      exec.signal.throwIfAborted()
      stage(exec, { session, turn: boundary.lastTurn, files })
      return { path: args.path, title: args.title, mediaType }
    },
  }))
}
