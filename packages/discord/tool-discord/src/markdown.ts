/**
 * Discord Markdown presentation using the shared CommonMark and GFM parser.
 * @module @deepseek-ai/dsh-tool-discord/markdown
 */

import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'

/** Parsed node fields used to preserve source Markdown around tables and code. */
interface MarkdownNode {
  readonly type: string
  readonly children?: readonly MarkdownNode[]
  readonly position: {
    readonly start: { readonly offset: number }
    readonly end: { readonly offset: number }
  }
}

/** GFM tables have a header row and at least one cell in each parsed row. */
interface MarkdownTable extends MarkdownNode {
  readonly children: readonly [MarkdownRow, ...MarkdownRow[]]
}

interface MarkdownRow extends MarkdownNode {
  readonly children: readonly [MarkdownCell, ...MarkdownCell[]]
}

interface MarkdownCell extends MarkdownNode {
  readonly children: readonly MarkdownNode[]
}

interface MarkdownBlocks {
  readonly table: MarkdownTable
  readonly code: MarkdownNode
}

/** Source offsets supplied on every node by fromMarkdown. */
function offsets(node: MarkdownNode): { start: number; end: number } {
  return { start: node.position.start.offset, end: node.position.end.offset }
}

/** Collect parsed blocks of one kind without inspecting the text inside other block kinds. */
function blocks<K extends keyof MarkdownBlocks>(content: string, type: K): MarkdownBlocks[K][] {
  const result: MarkdownBlocks[K][] = []
  const visit = (node: MarkdownNode): void => {
    if (node.type === type) result.push(node as MarkdownBlocks[K])
    else for (const child of node.children ?? []) visit(child)
  }
  // fromMarkdown supplies positions; the generic mdast interfaces also represent positionless trees.
  visit(fromMarkdown(content, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as MarkdownNode)
  return result
}

/** Source Markdown of a parsed cell, retaining links, code, and escaped separators. */
function cellText(content: string, cell: MarkdownCell): string {
  return cell.children.map((child) => {
    const { start, end } = offsets(child)
    return content.slice(start, end)
  }).join('').trim()
}

/** Render each table row as a labeled group; empty cells retain their column label. */
function tableText(content: string, table: MarkdownTable): string {
  const [header, ...rows] = table.children
  const headers = header.children.map(cell => cellText(content, cell))
  if (rows.length === 0) return headers.map(label => `**${label}**`).join(' • ')
  return rows.map((row) => {
    const [first, ...rest] = row.children
    const title = cellText(content, first)
    const cells = rest.map(cell => cellText(content, cell))
    const heading = title === '' ? '' : title.startsWith('**') && title.endsWith('**') ? title : `**${title}**`
    return [heading, ...headers.slice(1).map((label, index) => `• ${label}: ${cells[index] ?? ''}`)]
      .filter(line => line !== '').join('\n')
  }).join('\n\n')
}

/**
 * Convert GFM tables to labeled bullet groups while retaining all other source Markdown.
 * @param content - complete model-authored Markdown; fenced examples remain literal.
 * @returns Discord-readable Markdown without changing stored model or session text.
 */
export function formatDiscordMarkdown(content: string): string {
  let formatted = content
  for (const table of blocks(content, 'table').reverse()) {
    const { start, end } = offsets(table)
    const lineStart = content.lastIndexOf('\n', start - 1) + 1
    const prefix = content.slice(lineStart, start).replace(/[^>\s]/g, ' ')
    const rendered = tableText(content, table).replaceAll('\n', `\n${prefix}`)
    formatted = formatted.slice(0, start) + rendered + formatted.slice(end)
  }
  return formatted
}

/**
 * Locate code blocks with their original Markdown for fence-aware delivery.
 * @param content - Markdown after presentation transformations.
 * @returns code blocks in source order, including their source offsets.
 */
export function discordCodeBlocks(content: string): readonly { start: number; end: number; text: string }[] {
  return blocks(content, 'code').map((node) => {
    const { start, end } = offsets(node)
    return { start, end, text: content.slice(start, end) }
  })
}
