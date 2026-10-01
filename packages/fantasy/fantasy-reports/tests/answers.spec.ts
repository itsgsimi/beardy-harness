import { describe, expect, it } from 'vitest'
import {
  holdsJsonObject, parseCalls, parseCheck, parseComparisons, parseJsonObject, parseSummary, parseWaivers, prose,
} from '../src/answers.ts'

const shown = new Map([['P1', new Set([1])], ['P2', new Set<number>()], ['P3', new Set([3, 4])], ['P4', new Set<number>()],
  ['P5', new Set<number>()], ['P6', new Set<number>()], ['P7', new Set<number>()], ['P8', new Set<number>()]])

describe('stage JSON', () => {
  it('reads one object from fenced or wrapped answers and refuses anything else with fixed messages', () => {
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(() => parseJsonObject('no json')).toThrow('the response contains no JSON object')
    expect(() => parseJsonObject('{"a":}')).toThrow('the response JSON object does not parse')
    expect(parseJsonObject('[{"a":1}]')).toEqual({ a: 1 })
    expect(holdsJsonObject('{"a":1}')).toBe(true)
    expect(holdsJsonObject('<tool_call>search</tool_call>')).toBe(false)
  })

  it('bounds prose and refuses URLs', () => {
    expect(prose('  two\n words ', 9)).toBe('two words')
    expect(prose('', 9)).toBeUndefined()
    expect(prose('x'.repeat(10), 9)).toBeUndefined()
    expect(prose('see https://x.example', 90)).toBeUndefined()
    expect(prose(3, 9)).toBeUndefined()
  })
})

describe('per-player calls', () => {
  it('keeps each valid player and names why each other requested player is invalid', () => {
    const answer = JSON.stringify({
      p1: { call: ' start ', reason: 'Healthy and starting.', sources: ['1', 1] },
      P2: { call: 'BENCH', reason: 'Bench him.' },
      P3: { call: 'SIT', reason: 'x'.repeat(201), sources: [3] },
      P4: 'START',
      P5: { call: 'HOLD', reason: 'Out this week.', sources: [9] },
      P6: { call: 'FLEX', reason: 'Flex play.', sources: 7 },
      P7: { call: 5, reason: 'Numbered.' },
      P99: { call: 'START', reason: 'Not requested.' },
    })
    const result = parseCalls(answer, shown)
    expect([...result.valid]).toEqual([['P1', { call: 'START', reason: 'Healthy and starting.', sources: [1] }]])
    expect(Object.fromEntries(result.invalid)).toEqual({
      P2: 'call must be START, SIT, FLEX, or HOLD', P3: 'reason must be 1 to 200 characters without URLs', P4: 'not an object',
      P5: 'source 9 was not shown for it', P6: 'sources must be an array', P7: 'call must be START, SIT, FLEX, or HOLD', P8: 'missing',
    })
    const absent = parseCalls(JSON.stringify({ P2: { call: 'SIT', reason: 'Depth.', sources: null } }), new Map([['P2', new Set<number>()]]))
    expect(absent.valid.get('P2')).toEqual({ call: 'SIT', reason: 'Depth.', sources: [] })
  })

  it('makes every requested player invalid when the answer is not JSON', () => {
    const result = parseCalls('I will look this up first.', new Map([['P1', new Set<number>()], ['P2', new Set<number>()]]))
    expect(result.valid.size).toBe(0)
    expect(Object.fromEntries(result.invalid)).toEqual({ P1: 'the response contains no JSON object', P2: 'the response contains no JSON object' })
  })
})

describe('close calls, waivers, summaries, and reason checks', () => {
  it('keeps only valid comparisons', () => {
    const pairs = new Map([['C1', new Set([5, 8])], ['C2', new Set<number>()], ['C3', new Set<number>()]])
    const valid = parseComparisons(JSON.stringify({ c1: { text: 'Start Flowers if he practices fully.', sources: [5] },
      C2: { text: 'Cites the wrong page.', sources: [5] }, C3: 'text' }), pairs)
    expect([...valid]).toEqual([['C1', { text: 'Start Flowers if he practices fully.', sources: [5] }]])
    expect(() => parseComparisons('none', pairs)).toThrow('no JSON object')
  })

  it('drops unknown, repeated, malformed, and surplus waiver picks', () => {
    const ids = new Set(['W1', 'W2', 'W3'])
    expect(parseWaivers(JSON.stringify({ picks: [{ id: 'w2', reason: 'Starts now.' }, { id: 'W9', reason: 'Unknown.' },
      { id: 'W2', reason: 'Again.' }, { id: 'W1' }, 'W3', { id: 3, reason: 'Number.' }, { id: 'W3', reason: 'Depth.' },
      { id: 'W1', reason: 'Late.' }] }), ids, 2)).toEqual([{ id: 'W2', reason: 'Starts now.' }, { id: 'W3', reason: 'Depth.' }])
    expect(() => parseWaivers('{"picks":"W1"}', ids, 2)).toThrow('picks must be an array')
  })

  it('checks summaries by length only and reads flagged reason ids', () => {
    expect(parseSummary('{"summary":"The Googies keep their lineup and watch Flowers on Friday."}'))
      .toBe('The Googies keep their lineup and watch Flowers on Friday.')
    expect(() => parseSummary('{"summary":"Short."}')).toThrow('summary must be 40 to 900 characters without URLs')
    expect(parseCheck('{"unsupported":["p3"," P5 ","P9",4]}', new Set(['P3', 'P5']))).toEqual(new Set(['P3', 'P5']))
    expect(() => parseCheck('{"unsupported":"P3"}', new Set(['P3']))).toThrow('unsupported must be an array')
  })
})
