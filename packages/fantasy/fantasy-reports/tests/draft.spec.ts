import { describe, expect, it } from 'vitest'
import {
  applyPatch, blocksPublication, draftErrors, draftProse, filterReview, parseDraft, parseJsonObject, trimQuotes,
  type DraftContext, type Evidence, type FantasyDraft,
} from '../src/draft.ts'
import { normalizedText } from '../src/sources.ts'
import { playerPage, rosterIds, validDraft, yahoo } from './support.ts'

const players = new Map(yahoo.roster.players.map((player, index) => [rosterIds[index]!, player]))
const evidence: Evidence[] = rosterIds.map((id, index) => ({ id: index + 1, url: playerPage(index).url, title: `Player ${index + 1}`,
  players: [id], text: playerPage(index).text }))
const context: DraftContext = { players, slots: yahoo.settings.rosterSlots, week: 3, evidence }

function withRow(draft: FantasyDraft, id: string, change: Partial<FantasyDraft['players'][number]>): FantasyDraft {
  return { ...draft, players: draft.players.map(row => row.player === id ? { ...row, ...change } : row) }
}

describe('draft parsing', () => {
  it('reads fenced JSON, coerces recommendation aliases, confidence case, and numeric source strings', () => {
    const draft = validDraft()
    const raw = JSON.parse(JSON.stringify(draft)) as { players: Array<Record<string, unknown>> }
    raw.players[0]!.recommendation = 'start if active'
    raw.players[1]!.confidence = 'HIGH'
    raw.players[2]!.facts = [{ text: 'Practiced fully on Wednesday.', source: '3', quote: 'practiced fully on Wednesday' }]
    const parsed = parseDraft(`Here you go:\n\`\`\`json\n${JSON.stringify(raw)}\n\`\`\``)
    expect(parsed.players[0]!.recommendation).toBe('CONDITIONAL')
    expect(parsed.players[1]!.confidence).toBe('high')
    expect(parsed.players[2]!.facts[0]!.source).toBe(3)
    expect(parsed.lineup).toEqual(draft.lineup)
  })

  it('rejects answers without the required shape', () => {
    const draft = JSON.parse(JSON.stringify(validDraft())) as Record<string, unknown>
    const broken = (change: (value: Record<string, unknown>) => void): string => {
      const copy = JSON.parse(JSON.stringify(draft)) as Record<string, unknown>
      change(copy)
      return JSON.stringify(copy)
    }
    const row = (copy: Record<string, unknown>) => (copy.players as Array<Record<string, unknown>>)[0]!
    expect(() => parseDraft('no json')).toThrow('contains no JSON object')
    expect(() => parseJsonObject('{"a":1} [2] }')).toThrow()
    expect(parseJsonObject('[{"a":1}]')).toEqual({ a: 1 })
    expect(() => parseJsonObject('} {')).toThrow('contains no JSON object')
    expect(() => parseDraft(broken((copy) => { copy.players = {} }))).toThrow('players must be an array')
    expect(() => parseDraft(broken((copy) => { (copy.players as unknown[])[0] = 'P1' }))).toThrow('players[0] must be an object')
    expect(() => parseDraft(broken((copy) => { row(copy).player = 7 }))).toThrow('players[0].player must be a string')
    expect(() => parseDraft(broken((copy) => { row(copy).recommendation = 'PLAY' }))).toThrow('recommendation must be START')
    expect(() => parseDraft(broken((copy) => { row(copy).confidence = 'certain' }))).toThrow('confidence must be high')
    expect(() => parseDraft(broken((copy) => { row(copy).facts = ['x'] }))).toThrow('facts[0] must be an object')
    expect(() => parseDraft(broken((copy) => { row(copy).facts = [{ text: 't', source: 'one', quote: 'q' }] }))).toThrow('source must be an integer')
    expect(() => parseDraft(broken((copy) => { (copy.lineup as unknown[])[0] = 3 }))).toThrow('lineup[0] must be an object')
    expect(() => parseDraft(broken((copy) => { (copy.decisions as unknown[])[0] = null }))).toThrow('decisions[0] must be an object')
    expect(() => parseDraft(broken((copy) => { copy.decisions = [{ title: 't', text: 'x', sources: ['1'] }] }))).toThrow('sources must be integers')
    expect(() => parseDraft(broken((copy) => { copy.actions = [1] }))).toThrow('actions[0] must be a string')
  })

  it('patches only changed rows and non-empty sections, rejecting unknown rows', () => {
    const draft = validDraft()
    const changed = { ...draft.players[1]!, reason: 'Gibbs is the clear starter.' }
    const patched = applyPatch(draft, JSON.stringify({ players: [changed], lineup: [], actions: ['Start Gibbs.'], decisions: [], caveats: [] }))
    expect(patched.players[1]!.reason).toBe('Gibbs is the clear starter.')
    expect(patched.players[0]).toEqual(draft.players[0])
    expect(patched.actions).toEqual(['Start Gibbs.'])
    expect(patched.lineup).toEqual(draft.lineup)
    const sections = applyPatch(draft, JSON.stringify({ lineup: [{ slot: 'qb', player: 'P9' }],
      decisions: [{ title: 'QB', text: 'Daniels returns from injury and takes the QB spot.', sources: [9] }], caveats: ['New caveat.'] }))
    expect(sections.lineup).toEqual([{ slot: 'QB', player: 'P9' }])
    expect(sections.caveats).toEqual(['New caveat.'])
    expect(sections.decisions[0]!.title).toBe('QB')
    expect(() => applyPatch(draft, JSON.stringify({ players: [{ ...changed, player: 'P99' }] }))).toThrow('unknown player P99')
  })
})

describe('draft code checks', () => {
  it('accepts a complete draft with literal quotes and a legal lineup', () => {
    expect(draftErrors(validDraft(), context)).toEqual([])
  })

  it('requires literal quotes from pages that name the player, case- and space-insensitively', () => {
    const draft = validDraft()
    expect(draftErrors(withRow(draft, 'P1', { facts: [{ text: 'Practiced.', source: 1, quote: 'PRACTICED   fully on Wednesday' }] }), context)).toEqual([])
    expect(draftErrors(withRow(draft, 'P1', { facts: [{ text: 'Cleared.', source: 1, quote: 'was cleared by team doctors' }] }), context))
      .toEqual(['P1: fact 0 quote is not a 12 to 300 character excerpt of source 1'])
    expect(draftErrors(withRow(draft, 'P1', { facts: [{ text: 'Short.', source: 1, quote: 'practiced' }] }), context))
      .toEqual(['P1: fact 0 quote is not a 12 to 300 character excerpt of source 1'])
    expect(draftErrors(withRow(draft, 'P1', { facts: [{ text: 'Practiced.', source: 99, quote: 'practiced fully on Wednesday' }] }), context))
      .toEqual(['P1: fact 0 cites unknown source 99'])
    expect(draftErrors(withRow(draft, 'P1', { facts: [{ text: 'Practiced.', source: 2, quote: 'practiced fully on Wednesday' }] }), context))
      .toEqual(['P1: fact 0 cites source 2, which does not name Trevor Lawrence'])
    const shared = { ...context, evidence: [...evidence, { id: 16, url: 'https://news.example/shared', title: 'Depth chart',
      players: ['P2'], text: 'Trevor Lawrence and Jahmyr Gibbs both practiced fully on Wednesday.' }] }
    expect(draftErrors(withRow(draft, 'P1', { facts: [{ text: 'Practiced.', source: 16, quote: 'both practiced fully on Wednesday' }] }), shared)).toEqual([])
    expect(draftErrors(withRow(draft, 'P1', { facts: [{ text: 'x', source: 1, quote: 'practiced fully on Wednesday' }] }), context))
      .toEqual(['P1: fact 0 text must be 5 to 400 characters without URLs'])
  })

  it('requires every roster row once, bounded prose, and facts where sources exist', () => {
    const draft = validDraft()
    const rows = draft.players
    expect(draftErrors({ ...draft, players: [...rows.slice(1), { ...rows[1]!, player: 'P99' }, rows[1]!] }, context)).toEqual([
      'P99: not a roster id', 'P2: appears more than once', 'P1: missing roster row'])
    expect(draftErrors(withRow(draft, 'P8', { reason: 'See https://example.com', watch: '' }), context)).toEqual([
      'P8: reason must be 1 to 550 characters without URLs', 'P8: watch must be 1 to 250 characters without URLs'])
    expect(draftErrors(withRow(draft, 'P8', { facts: [] }), context)).toEqual(['P8: needs 1 to 3 facts from its admitted sources'])
    const noSource = { ...context, evidence: evidence.filter(source => source.id !== 8) }
    expect(draftErrors(withRow(draft, 'P8', { facts: [] }), noSource)).toEqual([])
    const fact = rows[7]!.facts[0]!
    expect(draftErrors(withRow(draft, 'P8', { facts: [fact, fact, fact, fact] }), context)).toEqual(['P8: needs 1 to 3 facts from its admitted sources'])
  })

  it('checks lineup legality, starter recommendations, and section bounds', () => {
    const draft = validDraft()
    expect(draftErrors(withRow(draft, 'P7', { recommendation: 'HOLD' }), context)).toEqual(['P7: starts in W/R/T but is recommended HOLD'])
    const swapped = { ...draft, lineup: draft.lineup.map(item => item.slot === 'QB' ? { ...item, player: 'P9' } : item) }
    expect(draftErrors(withRow(swapped, 'P9', { recommendation: 'START' }), context))
      .toEqual(['lineup: P9 cannot start because Jayden Daniels has Yahoo status O'])
    expect(draftErrors({ ...draft, actions: [], caveats: ['https://example.com'], decisions: [] }, context)).toEqual([
      'actions: needs 1 to 4 entries of at most 500 characters without URLs',
      'caveats: needs 1 to 5 entries of at most 400 characters without URLs', 'decisions: needs 1 to 4 comparisons'])
    expect(draftErrors({ ...draft, decisions: [{ title: '', text: 'short', sources: [] }, { title: 'T', text: 'x'.repeat(40), sources: [99] }] }, context))
      .toEqual(['decisions[0]: title needs 1 to 120 and text 30 to 1200 characters without URLs',
        'decisions[0]: sources must cite admitted source numbers', 'decisions[1]: sources must cite admitted source numbers'])
  })

  it('trims copied navigation, surrounding quote marks, and oversized quotes that remain literal', () => {
    const long = `${'Hall ran hard. '.repeat(30)}End.`
    const page: Evidence = { id: 1, url: 'https://news.example/p1', title: 't', players: ['P1'],
      text: `Player News View More News Trevor Lawrence practiced fully on Wednesday. ${long}` }
    const draft = withRow(validDraft(), 'P1', { facts: [
      { text: 'Practiced.', source: 1, quote: '"Player News View More News Trevor Lawrence practiced fully on Wednesday."' },
      { text: 'Long.', source: 1, quote: long },
      { text: 'Invented.', source: 1, quote: 'never said this at all' },
      { text: 'Unknown.', source: 5, quote: 'practiced fully on Wednesday' },
    ] })
    const facts = trimQuotes(draft, [page]).players[0]!.facts
    expect(facts[0]!.quote).toBe('Trevor Lawrence practiced fully on Wednesday.')
    expect(facts[1]!.quote.length).toBeLessThanOrEqual(300)
    expect(normalizedText(page.text)).toContain(normalizedText(facts[1]!.quote))
    expect(facts[2]!.quote).toBe('never said this at all')
    expect(facts[3]!.quote).toBe('practiced fully on Wednesday')
    const unbroken = 'x'.repeat(320)
    expect(trimQuotes(withRow(validDraft(), 'P1', { facts: [{ text: 'Long.', source: 1, quote: unbroken }] }),
      [{ ...page, text: unbroken }]).players[0]!.facts[0]!.quote).toHaveLength(300)
  })
})

describe('anchored review findings', () => {
  const draft = validDraft()
  const supplied = normalizedText(`${evidence.map(source => source.text).join(' ')} {"status":"O"}`)
  const ids = new Set(rosterIds)
  const issue = { player: 'P7', kind: 'contradicts_source', claim: 'Row P7: the practice report supports this choice.',
    evidence: 'Breece Hall practiced fully on Wednesday', problem: 'p', fix: 'Fix it.' }

  it('keeps verbatim claims with verbatim or empty evidence, including elided and short excerpts', () => {
    const kept = filterReview({ issues: [
      issue,
      { ...issue, player: null, claim: 'Keep the current Yahoo lineup.', evidence: '' },
      { ...issue, player: 'P1', claim: 'Row P1: the practice report … supports this choice.', evidence: undefined },
      { ...issue, player: 'P5', kind: 'medical_speculation', claim: 'medium', evidence: '"status":"O"' },
    ] }, draft, supplied, ids)
    expect(kept.discarded).toEqual([])
    expect(kept.issues.map(item => item.player)).toEqual(['P7', null, 'P1', 'P5'])
    expect(kept.issues[2]!.evidence).toBe('')
    expect(draftProse(draft)).toContain('keep the current yahoo lineup.')
  })

  it('discards malformed, unanchored, wording-only, non-fix, unknown, and repeated findings', () => {
    const filtered = filterReview({ issues: [
      'not an object', { ...issue, fix: 3 }, { ...issue, evidence: 5 }, { ...issue, kind: 'style' }, { ...issue, player: 'P99' },
      { ...issue, fix: 'No change needed.' }, { ...issue, kind: 'wording_or_precision' }, { ...issue, claim: 'Invented claim text here' },
      { ...issue, claim: '' }, { ...issue, evidence: 'Hall was ruled out for the season' }, issue, issue,
    ] }, draft, supplied, ids)
    expect(filtered.issues).toHaveLength(1)
    expect(filtered.discarded.map(item => item.reason)).toEqual(['malformed', 'malformed', 'malformed', 'unknown kind',
      'unknown player', 'no fix', 'wording only', 'claim not in draft', 'claim not in draft', 'evidence not in supplied text', 'repeat'])
    expect(() => filterReview({ issues: 'none' }, draft, supplied, ids)).toThrow('issues must be an array')
  })

  it('blocks publication only for wrong team, schedule, or season findings', () => {
    const base = { player: null, claim: 'c', evidence: '', problem: 'p', fix: 'f' }
    expect(blocksPublication({ ...base, kind: 'wrong_team_or_schedule' })).toBe(true)
    expect(blocksPublication({ ...base, kind: 'stale_season' })).toBe(true)
    expect(blocksPublication({ ...base, kind: 'contradicts_source' })).toBe(false)
  })
})
