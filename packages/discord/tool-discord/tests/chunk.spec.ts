import { describe, expect, it } from 'vitest'
import { chunkContent, DISCORD_MAX_CONTENT_CHARS, sliceUnits } from '../src/chunk.ts'

/** Every non-whitespace character in order, so joins that drop whitespace still compare equal. */
function textSkeleton(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

describe('sliceUnits', () => {
  it('returns short input unchanged as one piece', () => {
    expect(sliceUnits('short', 10)).toEqual(['short'])
  })

  it('cuts at exactly the limit without dropping characters', () => {
    expect(sliceUnits('abcdef', 3)).toEqual(['abc', 'def'])
  })

  it('backs off a cut that would split a surrogate pair', () => {
    const pieces = sliceUnits('\u{1F600}\u{1F600}', 3)
    expect(pieces).toEqual(['\u{1F600}', '\u{1F600}'])
    for (const piece of pieces) {
      expect(piece).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
      expect(piece).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
    }
  })

  it('returns no piece for empty input', () => {
    expect(sliceUnits('', 10)).toEqual([])
  })

  it('cuts without leaving a remainder when the length is an exact multiple', () => {
    expect(sliceUnits('abcdef', 2)).toEqual(['ab', 'cd', 'ef'])
  })

  it('cuts after a complete pair when the boundary lands on its low half', () => {
    expect(sliceUnits('x\u{1F600}yy', 3)).toEqual(['x\u{1F600}', 'yy'])
  })

  it.each([1, 0, -2, 1.5, Number.NaN])('rejects a limit that cannot hold text: %p', (limit) => {
    expect(() => sliceUnits('abc', limit)).toThrow(RangeError)
  })
})

describe('chunkContent', () => {
  it('keeps a short body in one chunk', () => {
    expect(chunkContent('Morning brief.\n\nWeather: sunny.')).toEqual(['Morning brief.\n\nWeather: sunny.'])
  })

  it('returns no chunk for whitespace-only input', () => {
    expect(chunkContent('   \n\n  \t ')).toEqual([])
  })

  it('keeps a body of exactly the limit in one chunk', () => {
    const content = 'a'.repeat(DISCORD_MAX_CONTENT_CHARS)
    const chunks = chunkContent(content)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe(content)
  })

  it('splits a long body on whitespace boundaries without losing text', () => {
    const content = Array.from({ length: 400 }, (_unused, index) => `word${String(index)}`).join(' ')
    const chunks = chunkContent(content)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(DISCORD_MAX_CONTENT_CHARS)
    expect(textSkeleton(chunks.join('\n'))).toBe(textSkeleton(content))
  })

  it('breaks only between paragraphs when every paragraph fits', () => {
    const content = Array.from({ length: 40 }, (_unused, index) => `## Section ${String(index)}\n\n${'x'.repeat(60)}`).join('\n\n')
    const chunks = chunkContent(content, 200)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(200)
    expect(chunks.join('\n\n').split('\n\n')).toEqual(content.split('\n\n'))
  })

  it('breaks between lines when one block exceeds the limit', () => {
    const lines = Array.from({ length: 60 }, (_unused, index) => `line ${String(index)} ${'y'.repeat(20)}`)
    const content = lines.join('\n')
    const chunks = chunkContent(content, 200)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(200)
    expect(chunks.join('\n').split('\n')).toEqual(lines)
  })

  it('hard-slices a single token longer than the limit', () => {
    const chunks = chunkContent(`lead ${'z'.repeat(DISCORD_MAX_CONTENT_CHARS + 250)} tail`)
    expect(chunks).toEqual([
      'lead',
      'z'.repeat(DISCORD_MAX_CONTENT_CHARS),
      `${'z'.repeat(250)} tail`,
    ])
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(DISCORD_MAX_CONTENT_CHARS)
  })

  it('counts an astral character as two units so Discord never rejects a chunk', () => {
    const content = '\u{1F600}'.repeat(1200)
    const chunks = chunkContent(content)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(DISCORD_MAX_CONTENT_CHARS)
    expect(chunks.join('')).toBe(content)
  })

  it('drops a whitespace run that alone exceeds the limit', () => {
    expect(chunkContent(`head\n${' '.repeat(2_010)}\ntail`, 2_000)).toEqual(['head\ntail'])
  })

  it('converts tables before measuring message limits', () => {
    const rows = Array.from({ length: 15 }, (_unused, index) => `| Item ${String(index)} | 😀😀 |`)
    const chunks = chunkContent(`| Name | Status |\n| --- | --- |\n${rows.join('\n')}`, 100)
    expect(chunks.join('\n')).toContain('**Item 14**\n• Status: 😀😀')
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100)
    expect(chunks.join('\n')).not.toContain('| --- |')
  })

  it('closes and reopens code with its language, indentation, and blank lines', () => {
    const content = 'Before.\n\n```python\nif ready:\n    first()\n\n    second()\n    third()\n```\n\nAfter.'
    const chunks = chunkContent(content, 43)
    expect(chunks).toEqual([
      'Before.',
      '```python\nif ready:\n    first()\n\n```',
      '```python\n    second()\n    third()\n```',
      'After.',
    ])
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(43)
  })

  it('preserves all Unicode code characters through hard line cuts', () => {
    const source = '    ' + '😀'.repeat(60)
    const chunks = chunkContent(`\`\`\`js\n${source}\n\`\`\``, 33)
    expect(chunks.map(chunk => chunk.slice('```js\n'.length, -'\n```'.length)).join('')).toBe(source)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(33)
      expect(chunk).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
      expect(chunk).toMatch(/^```js\n[\s\S]*\n```$/)
    }
  })

  it('hard-cuts a long ASCII code line without dropping its characters', () => {
    const chunks = chunkContent('```txt\n' + 'abcdef'.repeat(20) + '\n```', 30)
    expect(chunks.map(chunk => chunk.slice('```txt\n'.length, -'\n```'.length)).join('')).toBe('abcdef'.repeat(20))
  })

  it('keeps short code blocks byte-for-byte and closes an unfinished long fence', () => {
    expect(chunkContent('```ts\n  x\n```')).toEqual(['```ts\n  x\n```'])
    const chunks = chunkContent('```ts\n' + 'x\n'.repeat(20), 20)
    for (const chunk of chunks) expect(chunk).toMatch(/^```ts\n[\s\S]*\n```$/)
  })

  it('keeps a short fenced block intact when surrounding prose needs several messages', () => {
    const chunks = chunkContent('Before.\n\n```ts\n  x\n```\n\nAfter with more text.', 18)
    expect(chunks).toContain('```ts\n  x\n```')
  })

  it('retains indentation while splitting indented code blocks', () => {
    const chunks = chunkContent('    ' + 'abcdef'.repeat(10), 12)
    expect(chunks.join('')).toBe('    ' + 'abcdef'.repeat(10))
  })

  it('rejects an oversized fence opener without a code body', () => {
    expect(() => chunkContent('```long-language', 8)).toThrow('cannot hold the code fence')
  })

  it('preserves a longer fence around code containing triple backticks', () => {
    const chunks = chunkContent('````text\n  ```\n  example\n  ```\n  finish\n````', 30)
    for (const chunk of chunks) {
      expect(chunk).toMatch(/^````text\n[\s\S]*\n````$/)
      expect(chunk.length).toBeLessThanOrEqual(30)
    }
    expect(chunks.join('\n')).toContain('  ```')
  })

  it('rejects a custom limit too small for the language and code wrappers', () => {
    expect(() => chunkContent('```javascript\nhello\n```', 15)).toThrow('cannot hold the code fence')
  })

  it.each([1, 0, Number.NaN])('rejects a limit that cannot hold text: %p', (limit) => {
    expect(() => chunkContent('abc', limit)).toThrow(RangeError)
  })
})
