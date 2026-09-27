/** Reader-facing Markdown of an accepted draft, sized for Discord. @module @deepseek-ai/dsh-fantasy-reports/render */

import type { FantasyMatchup, FantasyPlayer, FantasyRosterSlot } from '@deepseek-ai/dsh-fantasy/types'
import type { ReportMode } from './config.ts'
import type { DraftPlayer, Evidence, FantasyDraft } from './draft.ts'
import { lineupChanges } from './lineup.ts'

/** Everything a rendered report states besides the accepted draft. */
export interface RenderInput {
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
  readonly matchups: readonly FantasyMatchup[]
  readonly evidence: readonly Evidence[]
  /** Publication disclosure listed with the next checks. */
  readonly note?: string
}

const MODE_TITLES: Readonly<Record<ReportMode, string>> = {
  full: 'full report', thursday: 'Thursday update', sunday: 'Sunday update',
}
const STATUS_WORDS: Readonly<Record<DraftPlayer['recommendation'], string>> = {
  START: 'Start', SIT: 'Bench', HOLD: 'Bench / hold', CONDITIONAL: 'Conditional start',
}

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

function points(value: number | undefined): string {
  return value === undefined ? 'n/a' : value.toFixed(1)
}

/**
 * Render an accepted draft. Citation targets are angle-bracketed so Discord attaches no link previews.
 * When the full form exceeds the size bound, benched players keep their line and next check but drop
 * their rationale; a report that still exceeds the bound is withheld by the caller.
 * @param draft - accepted draft.
 * @param input - roster, league, and timing facts from Yahoo.
 * @param maxChars - largest rendered report.
 * @returns the report Markdown.
 */
export function renderReport(draft: FantasyDraft, input: RenderInput, maxChars: number): string {
  const full = render(draft, input, false)
  return full.length <= maxChars ? full : render(draft, input, true)
}

function render(draft: FantasyDraft, input: RenderInput, compact: boolean): string {
  const sources = new Map(input.evidence.map(source => [source.id, source]))
  const cite = (id: number): string => {
    const url = sources.get(id)?.url
    return url === undefined ? '' : `[${id}](<${url}>)`
  }
  const rows = new Map(draft.players.map(row => [row.player, row]))
  const cited = new Set<number>()
  const lines = [`# ${input.teamName} · ${input.season} week ${input.week} ${MODE_TITLES[input.mode]}`,
    `**${formatInstant(input.firedAt, input.timezone)} · Yahoo roster, slots, and scoring**`, '']
  for (const matchup of input.matchups) {
    lines.push(`Yahoo matchup: ${matchup.teams.map(team => `${team.name} (projected ${points(team.projectedPoints)})`).join(' vs ')}`, '')
  }
  lines.push('## What to do now', ...draft.actions.map(action => `- ${action}`), '')
  const changes = lineupChanges(draft.lineup, input.players, input.slots)
  if (changes.start.length + changes.bench.length > 0) {
    lines.push('## Changes from your Yahoo lineup',
      ...changes.start.map(player => `- Start ${player.name}`), ...changes.bench.map(player => `- Bench ${player.name}`), '')
  }
  lines.push('## Suggested lineup')
  for (const assignment of draft.lineup) {
    const name = (input.players.get(assignment.player) as FantasyPlayer).name
    lines.push(`- **${assignment.slot}** — ${name}${rows.get(assignment.player)?.recommendation === 'CONDITIONAL' ? ' — conditional' : ''}`)
  }
  lines.push('', 'Recommendations only: check final injury reports and your league\'s lineup locks before changing Yahoo.', '',
    '## The close calls')
  for (const decision of draft.decisions) {
    decision.sources.forEach(id => cited.add(id))
    lines.push(`**${decision.title}**`, `${decision.text} ${decision.sources.map(cite).join(' ')}`.trim(), '')
  }
  lines.push('## Every player')
  for (const [id, player] of input.players) {
    const row = rows.get(id) as DraftPlayer
    const refs = [...new Set(row.facts.map(fact => fact.source))]
    refs.forEach(ref => cited.add(ref))
    const positions = player.positions.filter(position => !position.includes('/') && position !== 'IR').join('/')
    const yahoo = [positions, player.nflTeam, `Yahoo slot ${player.selectedSlot ?? 'n/a'}`,
      player.byeWeek === undefined ? undefined : `bye ${player.byeWeek}`,
      player.status === undefined ? undefined : `status ${player.status}${player.injuryNote === undefined ? '' : ` (${player.injuryNote})`}`,
      player.projectedPoints === undefined ? undefined : `projected ${points(player.projectedPoints)}`]
      .filter(part => part !== undefined).join(' · ')
    lines.push(`**${player.name} — ${STATUS_WORDS[row.recommendation]}** · ${yahoo}`)
    const benched = row.recommendation === 'SIT' || row.recommendation === 'HOLD'
    if (!compact || !benched) lines.push(`${row.reason} ${refs.map(cite).join(' ')}`.trim())
    lines.push(`Watch: ${row.watch} · Confidence: ${row.confidence}`, '')
  }
  const unsourced = [...input.players].filter(([id]) => !input.evidence.some(source => source.players.includes(id)))
    .map(([, player]) => player.name)
  lines.push('## Next check', ...draft.caveats.map(caveat => `- ${caveat}`))
  if (unsourced.length > 0) lines.push(`- No current source was admitted for ${unsourced.join(', ')}; their rows rest on Yahoo data only.`)
  if (input.note !== undefined) lines.push(`- ${input.note}`)
  lines.push('', '## Sources')
  for (const id of [...cited].sort((a, b) => a - b)) {
    const source = sources.get(id)
    if (source !== undefined) lines.push(`[${id} · ${source.title.replace(/[[\]<>\n]/gu, '').slice(0, 85)}](<${source.url}>)`)
  }
  return `${lines.join('\n')}\n`
}
