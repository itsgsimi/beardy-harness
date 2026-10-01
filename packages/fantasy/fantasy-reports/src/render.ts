/** Reader-facing Markdown of a weekly report, sized for the delivery bound. @module @deepseek-ai/dsh-fantasy-reports/render */

import type { FantasyPlayer, FantasyRosterSlot, FantasyTeam } from '@deepseek-ai/dsh-fantasy/types'
import type { PlayerCall } from './calls.ts'
import type { ReportMode } from './config.ts'
import { type ClosePair, points, type WaiverCandidate } from './facts.ts'
import { lineupChanges, type LineupAssignment } from './lineup.ts'
import type { Evidence } from './news.ts'

/** Projected points per starting slot for the report's lineup and the opponent's Yahoo starters. */
export interface SlotComparison {
  readonly slot: string
  readonly ours: number
  readonly theirs: number
}

/** Everything a rendered report states. */
export interface ReportView {
  readonly teamName: string
  readonly season: string
  readonly week: number
  readonly mode: ReportMode
  /** Scheduled start time of the report. */
  readonly firedAt: number
  readonly timezone: string
  /** Roster players by short id, in roster order. */
  readonly players: ReadonlyMap<string, FantasyPlayer>
  readonly slots: readonly FantasyRosterSlot[]
  /** The team's Yahoo matchup entry and its opponent, when Yahoo returned the week's matchup. */
  readonly matchup?: { readonly ours: FantasyTeam; readonly opponent: FantasyTeam }
  /** Slot-by-slot projections, present only when Yahoo projected both lineups. */
  readonly comparison?: readonly SlotComparison[]
  readonly summary: string
  readonly lineup: readonly LineupAssignment[]
  readonly calls: ReadonlyMap<string, PlayerCall>
  readonly comparisons: ReadonlyArray<{ readonly pair: ClosePair; readonly text: string; readonly sources: readonly number[] }>
  readonly waivers: ReadonlyArray<{ readonly candidate: WaiverCandidate; readonly reason: string }>
  readonly caveats: readonly string[]
  readonly evidence: readonly Evidence[]
}

const MODE_TITLES: Readonly<Record<ReportMode, string>> = {
  full: 'full report', thursday: 'Thursday update', sunday: 'Sunday update',
}

/** Line that closes a report cut to the delivery bound. */
export const CUT_NOTICE = '_Cut to fit the delivery limit; the complete report is saved with its research run._'

/**
 * Format an instant in the report's timezone.
 * @param at - epoch milliseconds.
 * @param timezone - IANA timezone.
 * @returns a short weekday, date, time, and zone label.
 */
export function formatInstant(at: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(at)
}

/**
 * Render a report. Citation targets are angle-bracketed so Discord attaches no link previews. When the
 * full form exceeds the bound, benched players drop their reasons; when that still exceeds it, the
 * report is cut at a line boundary and ends with {@link CUT_NOTICE}.
 * @param view - facts, calls, and stage results.
 * @param maxChars - largest rendered report.
 * @returns the report Markdown, at most `maxChars` characters.
 */
export function renderReport(view: ReportView, maxChars: number): string {
  const full = render(view, false)
  if (full.length <= maxChars) return full
  const compact = render(view, true)
  if (compact.length <= maxChars) return compact
  const kept: string[] = []
  let size = CUT_NOTICE.length + 2
  for (const line of compact.split('\n')) {
    if (size + line.length + 1 > maxChars) break
    kept.push(line)
    size += line.length + 1
  }
  return `${kept.join('\n')}\n${CUT_NOTICE}\n`
}

function render(view: ReportView, compact: boolean): string {
  const sources = new Map(view.evidence.map(source => [source.id, source]))
  const cited = new Set<number>()
  const cite = (ids: readonly number[]): string => ids.map((id) => {
    cited.add(id)
    return `[${id}](<${(sources.get(id) as Evidence).url}>)`
  }).join(' ')
  const name = (id: string): string => (view.players.get(id) as FantasyPlayer).name
  const lines = [`# ${view.teamName} · ${view.season} week ${view.week} ${MODE_TITLES[view.mode]}`,
    `**${formatInstant(view.firedAt, view.timezone)} · Yahoo roster, slots, and projections**`, '']
  if (view.matchup !== undefined) {
    const { ours, opponent } = view.matchup
    const odds = ours.winProbability === undefined ? '' : ` · Yahoo win probability ${Math.round(ours.winProbability * 100)}%`
    lines.push(`**Matchup:** ${view.teamName} ${points(ours.projectedPoints)} vs ${opponent.name} ${points(opponent.projectedPoints)} `
      + `projected${odds}`)
    if (view.comparison !== undefined) {
      lines.push(`By slot (yours vs theirs): ${view.comparison.map(row => `${row.slot} ${points(row.ours)}–${points(row.theirs)}`).join(' · ')}`)
    }
    lines.push('')
  }
  lines.push('## Summary', view.summary, '', '## Lineup')
  const changes = lineupChanges(view.lineup, view.players, view.slots)
  if (changes.start.length + changes.bench.length > 0) {
    lines.push(`Changes from your Yahoo lineup: ${[...changes.start.map(id => `start ${name(id)}`),
      ...changes.bench.map(id => `bench ${name(id)}`)].join(', ')}.`)
  }
  for (const { slot, player: id } of view.lineup) {
    if (id === undefined) {
      lines.push(`- **${slot}** — empty: no eligible player can play`)
      continue
    }
    const player = view.players.get(id) as FantasyPlayer
    const marks = [player.nflTeam, `proj ${points(player.projectedPoints)}`,
      player.status === undefined ? undefined : `Yahoo ${player.status}${player.injuryNote === undefined ? '' : ` (${player.injuryNote})`}`,
      player.slotLocked === true ? 'locked' : undefined,
      changes.start.includes(id) ? `**start** (Yahoo ${player.selectedSlot ?? 'BN'})` : undefined]
    lines.push(`- **${slot}** ${player.name} · ${marks.filter(mark => mark !== undefined).join(' · ')}`)
  }
  const bench = [...view.players].filter(([id]) => !view.lineup.some(item => item.player === id))
  if (bench.length > 0) {
    lines.push('', `Bench: ${bench.map(([, player]) => `${player.name}${player.status === undefined ? '' : ` (${player.status})`}`
      + (player.slotLocked === true ? ' (locked)' : '')).join(', ')}`)
  }
  lines.push('', '## Player calls')
  for (const [id, player] of view.players) {
    const call = view.calls.get(id) as PlayerCall
    const facts = [player.positions.filter(position => !position.includes('/') && position !== 'IR').join('/'), player.nflTeam,
      player.byeWeek === undefined ? undefined : `bye ${player.byeWeek}`, call.origin === 'model' ? undefined : 'code reason']
    lines.push(`**${player.name} — ${call.call}** · ${facts.filter(fact => fact !== undefined).join(' · ')}`)
    if (!compact || call.call === 'START' || call.call === 'FLEX') lines.push(`${call.reason} ${cite(call.sources)}`.trim())
    lines.push('')
  }
  if (view.comparisons.length > 0) {
    lines.push('## Close calls')
    for (const { pair, text, sources: refs } of view.comparisons) {
      lines.push(`**${name(pair.starter)} or ${name(pair.bench)}** (${pair.slot})`, `${text} ${cite(refs)}`.trim(), '')
    }
  }
  if (view.waivers.length > 0) {
    lines.push('## Waiver ideas')
    for (const { candidate, reason } of view.waivers) {
      const player = candidate.player
      const facts = [candidate.position, player.nflTeam, player.percentOwned === undefined ? undefined : `${player.percentOwned}% owned`]
      lines.push(`- **${player.name}** · ${facts.filter(fact => fact !== undefined).join(' · ')} — ${reason}`)
    }
    lines.push('')
  }
  lines.push('## Caveats', ...view.caveats.map(caveat => `- ${caveat}`),
    '- Recommendations only: check final injury reports and Yahoo lineup locks before changing your lineup.')
  if (cited.size > 0) {
    lines.push('', '## Sources')
    for (const id of [...cited].sort((a, b) => a - b)) {
      const source = sources.get(id) as Evidence
      lines.push(`[${id} · ${source.title.replace(/[[\]<>\n]/gu, '').slice(0, 85)}](<${source.url}>)`)
    }
  }
  return `${lines.join('\n')}\n`
}
