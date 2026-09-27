/** Bounded HTML/text conversion shared by web_fetch and research. @module @deepseek-ai/dsh-tool-web/conversion */

import TurndownService from 'turndown'
import { gfm } from '@joplin/turndown-plugin-gfm'
import type { WebFetchBody } from '@deepseek-ai/dsh-web'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/**
 * The shared HTML→markdown converter: turndown over its bundled domino DOM,
 * with GitHub-flavored tables/strikethrough (`@joplin/turndown-plugin-gfm`).
 * The style options are fixed model-facing presentation (matching the repo's
 * markdown conventions), not deployment tunables. `remove` drops non-content
 * elements wholesale — turndown's default keeps their text. The instance is
 * stateless across `turndown()` calls and safe to share.
 */
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
})
turndown.use(gfm)
turndown.addRule('removeNonVisibleContent', {
  filter(node) {
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED'].includes(node.nodeName)) return true
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden')?.toLowerCase() === 'true') return true
    if (node.nodeName === 'INPUT' && node.getAttribute('type')?.toLowerCase() === 'hidden') return true
    const declarations = node.getAttribute('style')?.split(';') ?? []
    return declarations.some((declaration) => {
      const separator = declaration.indexOf(':')
      if (separator === -1) return false
      const property = declaration.slice(0, separator).trim().toLowerCase()
      const value = declaration.slice(separator + 1).trim().toLowerCase().replace(/\s*!important\s*$/u, '')
      return (property === 'display' && value === 'none')
        || (property === 'visibility' && (value === 'hidden' || value === 'collapse'))
    })
  },
  replacement() {
    return ''
  },
})

/** Render one GFM table cell without interpreting HTML span counts. */
function renderTableCell(content: string, index: number): string {
  const prefix = index === 0 ? '| ' : ' '
  const escaped = content.trim().replace(/\n\r/g, '<br>').replace(/\n/g, '<br>').replace(/\|+/g, '\\|').padEnd(3, ' ')
  return `${prefix}${escaped} |`
}

/** Whether a row is the table's Markdown heading row. */
function isTableHeadingRow(row: HTMLTableRowElement): boolean {
  const cells = Array.from(row.cells)
  const section = row.parentElement as HTMLTableSectionElement
  const table = section.parentElement as HTMLTableElement
  return (section.nodeName === 'THEAD' || table.rows[0] === row)
    && cells.every(cell => cell.nodeName === 'TH')
}

/** Map an HTML table-cell alignment to the GFM separator marker. */
function tableBorder(cell: HTMLTableCellElement): string {
  const alignment = (cell.getAttribute('align') || cell.style.textAlign || '').toLowerCase()
  if (alignment === 'left') return ':---'
  if (alignment === 'right') return '---:'
  if (alignment === 'center') return ':---:'
  return '---'
}

turndown.addRule('tableCellWithoutSpanExpansion', {
  filter: ['th', 'td'],
  replacement(content, node) {
    const cell = node as HTMLTableCellElement
    const row = cell.parentNode as HTMLTableRowElement
    // GFM cannot represent spanning cells. Ignoring colspan keeps conversion
    // work and output proportional to the source instead of the numeric attribute.
    return renderTableCell(content, Array.prototype.indexOf.call(row.childNodes, cell))
  },
})
turndown.addRule('tableRowWithoutSpanExpansion', {
  filter: 'tr',
  replacement(content, node) {
    const row = node as HTMLTableRowElement
    const border = isTableHeadingRow(row)
      ? Array.from(row.cells, (cell, index) => renderTableCell(tableBorder(cell), index)).join('')
      : ''
    return `\n${content}${border.length > 0 ? `\n${border}` : ''}`
  },
})

/**
 * Nesting-depth ceiling above which HTML skips conversion and passes through
 * raw. Conversion runs synchronously on the event loop, and unclosed-tag
 * nesting makes domino's tree (and turndown's walk over it) superlinear —
 * measured: depth 512 ≈ 0.15s, 2,000 ≈ 2s, 20,000 ≈ 5s — during which the
 * cooperative `fetchTimeoutMs` timer cannot fire. Real pages nest a few dozen
 * levels; 512 is far above content and far below weaponizable. A robustness
 * invariant, not a tunable.
 */
const MAX_CONVERSION_DEPTH = 512

/** Elements that never take a closing tag, so they do not grow the lexical stack. */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

/** Elements whose contents HTML parses as text until their matching end tag. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'noscript'])

/** Whether a character can occur after a raw-text end-tag name. */
function isTagBoundary(char: string | undefined): boolean {
  return char === undefined || char === '>' || char === '/' || /\s/.test(char)
}

/** Find the matching raw-text end tag without interpreting markup-like body text. */
function findRawTextEnd(lowerHtml: string, name: string, from: number): number {
  const prefix = `</${name}`
  let candidate = lowerHtml.indexOf(prefix, from)
  while (candidate !== -1 && !isTagBoundary(lowerHtml[candidate + prefix.length])) {
    candidate = lowerHtml.indexOf(prefix, candidate + prefix.length)
  }
  return candidate
}

/**
 * Conservatively reject HTML whose lexical element stack crosses the conversion
 * depth ceiling. The single pass ignores closing tags inside comments, skips
 * raw-text bodies, respects quoted `>` characters, and only accepts a closing
 * tag for the current element; malformed input therefore over-counts rather
 * than hiding nesting.
 *
 * @param html - the decoded HTML body.
 * @returns whether the body crosses {@link MAX_CONVERSION_DEPTH}.
 */
function exceedsConversionDepth(html: string): boolean {
  const lowerHtml = html.toLowerCase()
  const openElements: string[] = []
  let offset = 0
  let inComment = false

  while (offset < html.length) {
    const start = html.indexOf('<', offset)
    if (inComment) {
      const end = html.indexOf('-->', offset)
      if (end !== -1 && (start === -1 || end < start)) {
        inComment = false
        offset = end + 3
        continue
      }
    }
    if (start === -1) break
    if (!inComment && html.startsWith('<!--', start)) {
      inComment = true
      offset = start + 4
      continue
    }

    let cursor = start + 1
    const closing = html[cursor] === '/'
    if (closing) cursor += 1
    const nameStart = cursor
    while (/[a-zA-Z0-9-]/.test(html[cursor] ?? '')) cursor += 1
    if (cursor === nameStart || !/[a-zA-Z]/.test(html.charAt(nameStart))) {
      offset = start + 1
      continue
    }

    const name = lowerHtml.slice(nameStart, cursor)
    let quote: '"' | "'" | undefined
    while (cursor < html.length) {
      const char = html[cursor]
      cursor += 1
      if (quote !== undefined) {
        if (char === quote) quote = undefined
      } else if (char === '"' || char === "'") {
        quote = char
      } else if (char === '>') {
        break
      }
    }
    if (html[cursor - 1] !== '>') break

    if (closing) {
      if (!inComment && openElements.at(-1) === name) openElements.pop()
    } else {
      let last = cursor - 2
      while (/\s/.test(html.charAt(last))) last -= 1
      if (!VOID_ELEMENTS.has(name) && html[last] !== '/') {
        openElements.push(name)
        if (openElements.length > MAX_CONVERSION_DEPTH) return true
        if (!inComment && RAW_TEXT_ELEMENTS.has(name)) {
          const end = findRawTextEnd(lowerHtml, name, cursor)
          if (end === -1) break
          offset = end
          continue
        }
      }
    }
    offset = cursor
  }
  return false
}

interface RenderedBody {
  /** Converted text, or a fixed omission marker when conversion is unsafe. */
  text: string
  /** Whether the source was cut before conversion to bound synchronous work. */
  sourceTruncated: boolean
}

/**
 * Render a fetched body to model-facing markdown text.
 *
 * @param body - the decoded body; `html` is converted via turndown, `text`
 *   passes through verbatim.
 * @param maxInputChars - maximum source characters processed synchronously.
 * @returns the rendered prefix and whether the source was cut. HTML nested
 *   beyond {@link MAX_CONVERSION_DEPTH} or rejected by turndown is omitted so
 *   raw active markup never reaches the model-facing result.
 */
export function renderBody(body: WebFetchBody, maxInputChars: number): RenderedBody {
  const content = body.content.slice(0, maxInputChars)
  const sourceTruncated = content.length !== body.content.length
  switch (body.kind) {
    case 'html':
      if (exceedsConversionDepth(content)) return { text: '[HTML content omitted: unable to convert safely.]', sourceTruncated }
      try {
        return { text: turndown.turndown(content), sourceTruncated }
      } catch {
        // turndown's DOM walk recurses per element; malformed markup the lexical
        // guard cannot model can still throw RangeError. Provider errors remain
        // structured upstream; conversion failure returns no source markup.
        return { text: '[HTML content omitted: unable to convert safely.]', sourceTruncated }
      }
    case 'text':
      return { text: content, sourceTruncated }
    /* v8 ignore next 2 -- WebFetchBody is a closed union; this arm is unreachable and only makes adding a kind a compile error. */
    default:
      return assertNever(body, 'unhandled web fetch body kind')
  }
}
