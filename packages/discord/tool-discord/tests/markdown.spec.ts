import { describe, expect, it } from 'vitest'
import { formatDiscordMarkdown } from '../src/markdown.ts'

describe('formatDiscordMarkdown', () => {
  it('preserves native headings, emphasis, lists, links, and inline code', () => {
    const content = '# Result\n\n**Ready** and *checked*.\n\n- Open [the page](https://example.com).\n- Run `pnpm test`.'
    expect(formatDiscordMarkdown(content)).toBe(content)
  })

  it('renders table records as bold names and labeled values', () => {
    const content = 'Results:\n\n| Name | Score | Link |\n| --- | ---: | --- |\n| Alice | **95** | [report](https://example.com) |\n| Bob | 80 | `pending` |\n\nDone.'
    expect(formatDiscordMarkdown(content)).toBe('Results:\n\n**Alice**\n• Score: **95**\n• Link: [report](https://example.com)\n\n**Bob**\n• Score: 80\n• Link: `pending`\n\nDone.')
  })

  it('uses parsed cells for escaped pipes and preserves blank values', () => {
    expect(formatDiscordMarkdown('| Name | Value |\n| --- | --- |\n| **A** | `x\\|y` |\n| B | |'))
      .toBe('**A**\n• Value: `x\\|y`\n\n**B**\n• Value: ')
  })

  it('leaves code examples of tables untouched with backtick and tilde fences', () => {
    for (const fence of ['```', '~~~~']) {
      const content = `${fence}markdown\n| A | B |\n| --- | --- |\n| x | y |\n${fence}`
      expect(formatDiscordMarkdown(content)).toBe(content)
    }
  })

  it('preserves quote and list context around nested tables', () => {
    expect(formatDiscordMarkdown('> | Name | Value |\n> | --- | --- |\n> | A | 1 |\n> | B | 2 |'))
      .toBe('> **A**\n> • Value: 1\n> \n> **B**\n> • Value: 2')
    expect(formatDiscordMarkdown('- | Name | Value |\n  | --- | --- |\n  | A | 1 |'))
      .toBe('- **A**\n  • Value: 1')
  })

  it('does not convert pipe prose without a parsed table separator', () => {
    expect(formatDiscordMarkdown('a | b\nordinary text | c')).toBe('a | b\nordinary text | c')
  })

  it('retains header-only tables and missing row cells', () => {
    expect(formatDiscordMarkdown('| Name | Value |\n| --- | --- |')).toBe('**Name** • **Value**')
    expect(formatDiscordMarkdown('| Name | Value | Extra |\n| --- | --- | --- |\n| | 1 |\n| A | 2 |'))
      .toBe('• Value: 1\n• Extra: \n\n**A**\n• Value: 2\n• Extra: ')
  })
})
