import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { encodeSegment, labelsPath, metaPath, samplesPath, sessionDir } from '../src/paths.ts'

describe('encodeSegment', () => {
  it('throws on an empty segment', () => {
    expect(() => encodeSegment('')).toThrow(/empty/)
  })

  it('escapes the traversal segments . and ..', () => {
    expect(encodeSegment('.')).toBe('~002E')
    expect(encodeSegment('..')).toBe('~002E~002E')
  })

  it('leaves safe characters literal and escapes everything else, including ~', () => {
    expect(encodeSegment('abc-DEF_123.txt')).toBe('abc-DEF_123.txt')
    expect(encodeSegment('a/b~c')).toBe('a~002Fb~007Ec')
  })

  it('is injective: two distinct strings never collide', () => {
    expect(encodeSegment('a/b')).not.toBe(encodeSegment('a~002Fb'))
  })
})

describe('sidecar layout', () => {
  it('builds the session directory and its three artifact paths', () => {
    const id = SessionId('s-1')
    const dir = sessionDir('/root', id)
    expect(dir).toBe(join('/root', encodeSegment(id)))
    expect(samplesPath(dir)).toBe(join(dir, 'samples.jsonl'))
    expect(labelsPath(dir)).toBe(join(dir, 'labels.jsonl'))
    expect(metaPath(dir)).toBe(join(dir, 'meta.json'))
  })
})
