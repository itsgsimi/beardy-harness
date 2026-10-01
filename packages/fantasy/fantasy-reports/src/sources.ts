/** Roster-name admission and model-facing text of fetched pages. @module @deepseek-ai/dsh-fantasy-reports/sources */

import type { FantasyPlayer } from '@deepseek-ai/dsh-fantasy/types'

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v'])
const DEFENSE_POSITIONS = new Set(['DEF', 'DST', 'D/ST'])

/**
 * Case-folded, accent-free words with initials and apostrophes joined, for name matching.
 * @param text - page or name text.
 * @returns space-separated lowercase words.
 */
export function nameWords(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[.'\u2018\u2019]/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').toLowerCase().trim()
}

/**
 * Whether a roster entry is a team defense.
 * @param player - roster player.
 * @returns true for Yahoo team defense entries.
 */
export function isDefense(player: FantasyPlayer): boolean {
  return player.positions.some(position => DEFENSE_POSITIONS.has(position.toUpperCase()))
}

/** A player's name without a generational suffix, in matching form. */
function matchName(player: FantasyPlayer): string {
  const words = nameWords(player.name).split(' ')
  while (words.length > 1 && SUFFIXES.has(words.at(-1) as string)) words.pop()
  return words.join(' ')
}

/**
 * Admit a page for a player only when it names that player. Search engines return unrelated pages
 * for common names and news hosts return navigation shells; neither is evidence. A name too short
 * to match reliably admits the page rather than leaving the player without sources.
 * @param player - roster player the page was fetched for.
 * @param text - cleaned page text.
 * @returns whether a model may read the page as evidence about this player.
 */
export function admitsPlayer(player: FantasyPlayer, text: string): boolean {
  const name = matchName(player)
  if (name.length < 5) return true
  return ` ${nameWords(text)} `.includes(` ${name} `)
}

/** Plain difficulty wording for a strength-of-schedule rank among 32 defenses. */
function matchupLabel(rank: number): string {
  if (rank <= 10) return 'an easy matchup for this position'
  if (rank <= 21) return 'an average matchup for this position'
  return 'a hard matchup for this position'
}

/**
 * Remove misleading page furniture and rewrite inverse matchup ordinals before any model reads the page.
 * FantasyPros rank and projection headers read as league scoring, and "30th easiest opponent" (the
 * third hardest of 32) is read as favorable by writers and reviewers alike, so the ordinal is replaced
 * with plain difficulty words rather than explained.
 * @param url - final page URL.
 * @param text - rendered page text.
 * @returns cleaned text; quotes are later checked against this text.
 */
export function cleanSource(url: string, text: string): string {
  let cleaned = text
  const host = new URL(url).hostname.toLowerCase()
  if (host === 'fantasypros.com' || host.endsWith('.fantasypros.com')) {
    cleaned = cleaned.split('Footer Sections of the Site', 1)[0] as string
    cleaned = cleaned.replace(/Wk Rank \(ECR\)[\s\S]*?Start \/ Sit Availability\s*/gu, ' ').replace(/[ \t]{2,}/gu, ' ').trim()
  }
  return cleaned.replace(/\b(\d{1,2})(?:st|nd|rd|th) easiest opponent/giu, (_match, rank: string) => matchupLabel(Number(rank)))
}

/** The word a page most often uses for a player after the first mention: surname, or a defense's name. */
function windowTerm(player: FantasyPlayer): string | undefined {
  const words = player.name.split(/\s+/u).filter(Boolean)
  while (words.length > 1 && SUFFIXES.has(nameWords(words.at(-1) as string))) words.pop()
  const term = (isDefense(player) ? player.name : words.at(-1) ?? '').replace(/[^\p{L}\p{N}'.-]/gu, '')
  return term.length >= 3 ? term : undefined
}

/**
 * Keep literal, non-overlapping passages around roster names so a long page fits a model budget
 * without any model-made summary. The opening passage stays for dates and headlines.
 * @param text - cleaned page text.
 * @param players - roster players admitted for this page.
 * @param limit - character budget.
 * @returns the page when it fits, otherwise its joined passages cut to the budget.
 */
export function playerPassages(text: string, players: readonly FantasyPlayer[], limit: number): string {
  if (text.length <= limit) return text
  const spans: Array<[number, number]> = [[0, Math.min(1000, limit)]]
  for (const player of players) {
    const term = windowTerm(player)
    if (term === undefined) continue
    const pattern = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'giu')
    for (const match of [...text.matchAll(pattern)].slice(0, 6)) {
      spans.push([Math.max(0, match.index - 250), Math.min(text.length, match.index + match[0].length + 1600)])
    }
  }
  spans.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const span of spans) {
    const last = merged.at(-1)
    if (last !== undefined && span[0] <= last[1]) last[1] = Math.max(last[1], span[1])
    else merged.push([...span])
  }
  return merged.map(([start, end]) => text.slice(start, end)).join('\n[... source passage omitted ...]\n').slice(0, limit)
}

/**
 * One verbatim excerpt about a player: from the first sentence that names him, through following
 * sentences while they fit, cut at a word boundary. A page that never names him by surname, which name
 * admission allows only for short names, yields its opening text.
 * @param text - committed source text.
 * @param player - roster player the page was admitted for.
 * @param maxChars - excerpt bound.
 * @returns an exact substring of `text`.
 */
export function playerExcerpt(text: string, player: FantasyPlayer, maxChars: number): string {
  const term = windowTerm(player)
  const sentences = [...text.matchAll(/[^.!?\n]+(?:[.!?]+|\n|$)/gu)]
  const escaped = term?.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const first = escaped === undefined ? -1 : sentences.findIndex(match => new RegExp(`\\b${escaped}\\b`, 'iu').test(match[0]))
  const start = first < 0 ? 0 : (sentences[first] as RegExpExecArray).index
  let end = start
  for (const match of sentences.slice(Math.max(first, 0))) {
    if (match.index + match[0].length - start > maxChars && end > start) break
    end = match.index + match[0].length
  }
  const excerpt = text.slice(start, Math.min(end, start + maxChars))
  if (end - start <= maxChars) return excerpt.trim()
  const space = excerpt.lastIndexOf(' ')
  return (space > maxChars / 2 ? excerpt.slice(0, space) : excerpt).trim()
}

/**
 * Whether a URL may be fetched: HTTPS on a host outside the exclusion list.
 * @param url - search result URL.
 * @param excludedHosts - lowercase host names; each also excludes its subdomains.
 * @returns true when the page may be fetched.
 */
export function fetchable(url: string, excludedHosts: readonly string[]): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const host = parsed.hostname.toLowerCase()
  return parsed.protocol === 'https:' && !excludedHosts.some(excluded => host === excluded || host.endsWith(`.${excluded}`))
}
