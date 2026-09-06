import { describe, expect, it } from 'vitest'
import {
  applyOperation,
  assertWithinCap,
  findEntry,
  MemoryDriftError,
  parseEntries,
  serializeEntries,
  validateEntry,
} from '../src/store.ts'

describe('parseEntries', () => {
  it('reads an empty file as no entries', () => {
    expect(parseEntries('', 'USER.md')).toEqual([])
  })

  it('reads one bullet per line and strips the prefix', () => {
    expect(parseEntries('- first fact\n- second fact\n', 'USER.md')).toEqual(['first fact', 'second fact'])
  })

  it('rejects a heading line naming its file and line number', () => {
    expect(() => parseEntries('- ok\n# Notes\n', 'MEMORY.md')).toThrow(MemoryDriftError)
    expect(() => parseEntries('- ok\n# Notes\n', 'MEMORY.md')).toThrow('MEMORY.md does not match the memory format: line 2')
  })

  it('rejects a bare dash, a blank line, and control characters', () => {
    expect(() => parseEntries('-\n', 'USER.md')).toThrow('line 1')
    expect(() => parseEntries('- ok\n\n- next\n', 'USER.md')).toThrow('line 2')
    expect(() => parseEntries('- ok\u0007bell\n', 'USER.md')).toThrow('line 1')
  })

  it('rejects a missing final newline only when a line is malformed', () => {
    expect(parseEntries('- no trailing newline', 'USER.md')).toEqual(['no trailing newline'])
  })
})

describe('serializeEntries', () => {
  it('round-trips through parse for any entry list', () => {
    const entries = ['User runs fish shell.', 'Prefers terse replies.']
    expect(parseEntries(serializeEntries(entries), 'USER.md')).toEqual(entries)
  })

  it('serializes no entries to empty text', () => {
    expect(serializeEntries([])).toBe('')
  })
})

describe('validateEntry', () => {
  it('trims and accepts a plain fact', () => {
    expect(validateEntry('  User runs fish shell.  ', 400)).toBe('User runs fish shell.')
  })

  it('rejects an entry that is empty after trimming', () => {
    expect(() => validateEntry('   ', 400)).toThrow('empty after trimming')
  })

  it('rejects newlines, headings, and fences', () => {
    expect(() => validateEntry('line one\nline two', 400)).toThrow('single lines')
    expect(() => validateEntry('# Heading', 400)).toThrow('not headings')
    expect(() => validateEntry('see ```ts``` here', 400)).toThrow('not code fences')
  })

  it('rejects an entry over the cap naming both sizes', () => {
    expect(() => validateEntry('x'.repeat(11), 10)).toThrow('11 characters, over the 10-character')
  })
})

describe('findEntry', () => {
  const entries = ['User runs fish shell.', 'User lives in Zagreb.']

  it('returns the index of the single match', () => {
    expect(findEntry(entries, 'Zagreb', 'replace')).toBe(1)
  })

  it('rejects an empty needle', () => {
    expect(() => findEntry(entries, '  ', 'remove')).toThrow('requires a non-empty old_text')
  })

  it('rejects zero matches and multiple matches distinctly', () => {
    expect(() => findEntry(entries, 'Berlin', 'remove')).toThrow('no entry contains "Berlin"')
    expect(() => findEntry(entries, 'User', 'replace')).toThrow('matches 2 entries')
  })
})

describe('applyOperation', () => {
  const entries = ['first fact', 'second fact']

  it('appends a validated entry on add', () => {
    expect(applyOperation(entries, { action: 'add', content: ' third fact ' }, 400))
      .toEqual(['first fact', 'second fact', 'third fact'])
  })

  it('requires content on add and old_text on replace and remove', () => {
    expect(() => applyOperation(entries, { action: 'add' }, 400)).toThrow('add requires content')
    expect(() => applyOperation(entries, { action: 'replace', content: 'x' }, 400)).toThrow('replace requires old_text')
    expect(() => applyOperation(entries, { action: 'remove' }, 400)).toThrow('remove requires old_text')
  })

  it('requires content on replace once a match is found', () => {
    expect(() => applyOperation(entries, { action: 'replace', old_text: 'first' }, 400))
      .toThrow('replace requires content')
  })

  it('replaces exactly one entry and removes exactly one entry', () => {
    expect(applyOperation(entries, { action: 'replace', old_text: 'second', content: 'NEW' }, 400))
      .toEqual(['first fact', 'NEW'])
    expect(applyOperation(entries, { action: 'remove', old_text: 'first' }, 400)).toEqual(['second fact'])
  })
})

describe('assertWithinCap', () => {
  it('accepts text at the cap and rejects one character over', () => {
    expect(() => assertWithinCap('- ok\n', 5, 'USER.md')).not.toThrow()
    expect(() => assertWithinCap('- over\n', 5, 'USER.md'))
      .toThrow('USER.md would be 7 characters, over its 5-character cap')
  })
})
