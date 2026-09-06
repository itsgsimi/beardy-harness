import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { canonicalJson, hashSystem, hashTools, sha256Hex } from '../src/hash.ts'

describe('sha256Hex', () => {
  it('prefixes the hex digest with sha256:', () => {
    expect(sha256Hex('hello')).toBe(`sha256:${createHash('sha256').update('hello', 'utf8').digest('hex')}`)
  })
})

describe('canonicalJson', () => {
  it('sorts object keys at every nesting level without adding whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
  })

  it('preserves array order while sorting keys of array elements', () => {
    expect(canonicalJson([{ b: 1, a: 2 }, { z: 1, y: 2 }])).toBe('[{"a":2,"b":1},{"y":2,"z":1}]')
  })

  it('leaves scalars and null untouched', () => {
    expect(canonicalJson('text')).toBe('"text"')
    expect(canonicalJson(42)).toBe('42')
    expect(canonicalJson(null)).toBe('null')
  })
})

describe('hashSystem', () => {
  it('hashes the empty string when the system prompt is absent', () => {
    expect(hashSystem(undefined)).toBe(sha256Hex(''))
  })

  it('hashes the exact system prompt text when present', () => {
    expect(hashSystem('be nice')).toBe(sha256Hex('be nice'))
  })
})

describe('hashTools', () => {
  it('hashes an empty array when tools are absent', () => {
    expect(hashTools(undefined)).toBe(sha256Hex('[]'))
  })

  it('hashes the canonical JSON of the tool schemas when present', () => {
    const tools = [{ name: 'bash', description: 'run', parameters: { type: 'object' } }]
    expect(hashTools(tools)).toBe(sha256Hex(canonicalJson(tools)))
  })
})
