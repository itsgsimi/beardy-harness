import { describe, expect, it } from 'vitest'
import { encodeSegment as persistenceEncodeSegment } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'
import { encodeSegment } from '../src/path-segment.ts'

describe('encodeSegment', () => {
  it('neutralizes traversal, separators, absolute paths, NUL, and the escape character', () => {
    expect(encodeSegment('..')).toBe('~002E~002E')
    expect(encodeSegment('.')).toBe('~002E')
    expect(encodeSegment('a/b')).toBe('a~002Fb')
    expect(encodeSegment('/etc/passwd')).toBe('~002Fetc~002Fpasswd')
    expect(encodeSegment('a\u0000b')).toBe('a~0000b')
    expect(encodeSegment('plain-ID_1.2')).toBe('plain-ID_1.2')
    expect(encodeSegment('a~b')).toBe('a~007Eb')
  })

  it('is injective over UTF-16 code units, including lone surrogates', () => {
    expect(encodeSegment(String.fromCharCode(0xD800))).toBe('~D800')
    expect(encodeSegment(String.fromCharCode(0xDC00))).toBe('~DC00')
    expect(encodeSegment('~002F')).not.toBe(encodeSegment('/'))
  })

  it('rejects an empty id', () => {
    expect(() => encodeSegment('')).toThrow(/empty/)
  })

  it('names directories exactly as the JSONL Session store does', () => {
    for (const id of ['cron-brief-1', '../x', 'a~b', '.', '..', 'é/\u0000', String.fromCharCode(0xD800)]) {
      expect(encodeSegment(id)).toBe(persistenceEncodeSegment(id))
    }
  })
})
