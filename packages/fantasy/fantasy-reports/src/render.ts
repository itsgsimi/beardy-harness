/** Reader-facing Markdown of a weekly report, sized for the delivery bound. @module @deepseek-ai/dsh-fantasy-reports/render */

import type { FantasyPlayer, FantasyRosterSlot, FantasyTeam, PlayerKey } from '@deepseek-ai/dsh-fantasy/types'
import type { PlayerCall } from './calls.ts'
import type { ReportMode } from './config.ts'
import { claimTiming, type Deadlines, gameDay } from './deadlines.ts'
import { type ClosePair, points, type PoolEntry, type WaiverCandidate } from './facts.ts'
import { lineupChanges, type LineupAssignment, uncertain } from './lineup.ts'
import type { ByeWeek, TradeChip } from './moves.ts'
import type { Evidence } from './news.ts'
import type { GameFacts, RecentForm } from './signals.ts'

/** Projected points per starting slot for the report's lineup and the opponent's Yahoo starters. */
export interface SlotComparison {
  readonly slot: string
  readonly ours: number
  readonly theirs: number
}

/** One waiver pick as a move: how it is acquired, what it drops, and its fallback when a claim fails. */
export interface MovePick {
  readonly candidate: WaiverCandidate
  /** Model reason for the pick. */
  readonly reason: string
  readonly kind: 'claim' | 'free agent'
  /** Average weekly best-lineup gain of this add with its drop. */
  readonly net: number
  /** Horizon length the gain is averaged over. */
  readonly weeks: number
  /** Roster id dropped to make room; absent when an open roster spot takes the add. */
  readonly drop?: string
  /** Best free agent at the claim's position, added if the claim fails. */
  readonly fallback?: PoolEntry
}

/** Roster moves a report suggests, with the team's waiver standing. */
export interface MovesView {
  /** Whether the waiver pool was read; off, the report suggests only IR moves. */
  readonly enabled: boolean
  /** Roster ids to move into empty IR slots. */
  readonly irMoves: readonly string[]
  readonly picks: readonly MovePick[]
  /** Average weekly lineup points lost by dropping each droppable roster player. */
  readonly dropCosts: ReadonlyMap<string, number>
  readonly waiverPriority?: number
  readonly faabBalance?: number
  /** Teams in the league, shown with the waiver priority. */
  readonly teams?: number
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
  /** Slot-by-slot projections, present only when a roster player is projected and the opponent's roster was read. */
  readonly comparison?: readonly SlotComparison[]
  readonly summary: string
  readonly lineup: readonly LineupAssignment[]
  readonly calls: ReadonlyMap<string, PlayerCall>
  readonly comparisons: ReadonlyArray<{ readonly pair: ClosePair; readonly text: string; readonly sources: readonly number[] }>
  readonly moves: MovesView
  /** Horizon weeks' byes and unfillable slots. */
  readonly byes: readonly ByeWeek[]
  /** Horizon weeks, starting with the report week. */
  readonly weeks: readonly number[]
  readonly chip?: TradeChip
  /** Recent form by player key; players without a read are absent. */
  readonly form: ReadonlyMap<PlayerKey, RecentForm>
  /** A player's report-week NFL game, when NFL data was read. */
  readonly game: (player: FantasyPlayer) => GameFacts | undefined
  /** Report-week deadlines, when NFL data was read. */
  readonly deadlines?: Deadlines
  /** Changes since the latest earlier report of the week, for Thursday and Sunday updates that could read it. */
  readonly since?: { readonly mode: ReportMode; readonly lines: readonly string[] }
  readonly caveats: readonly string[]
  readonly evidence: readonly Evidence[]
}

const MODE_TITLES: Readonly<Record<ReportMode, string>> = {
  waivers: 'waiver report', full: 'full report', thursday: 'Thursday update', sunday: 'Sunday update',
}

/** Positions whose adds render as a swap of the starter they replace. */
const SWAP_POSITIONS = new Set(['K', 'DEF'])

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

/** How much a rendering keeps: everything, without bench reasons, or also without the outlook sections. */
type Detail = 'full' | 'compact' | 'minimal'

/**
 * Render a report. Citation targets are angle-bracketed so Discord attaches no link previews. When the
 * full form exceeds the bound, benched players drop their reasons; when that still exceeds it, the bye
 * outlook and trade chip go; when that still exceeds it, the report is cut at a line boundary and ends
 * with {@link CUT_NOTICE}.
 * @param view - facts, calls, moves, and stage results.
 * @param maxChars - largest rendered report.
 * @returns the report Markdown, at most `maxChars` characters.
 */
export function renderReport(view: ReportView, maxChars: number): string {
  let text = ''
  for (const detail of ['full', 'compact', 'minimal'] as const) {
    text = render(view, detail)
    if (text.length <= maxChars) return text
  }
  const kept: string[] = []
  let size = CUT_NOTICE.length + 2
  for (const line of text.split('\n')) {
    if (size + line.length + 1 > maxChars) break
    kept.push(line)
    size += line.length + 1
  }
  return `${kept.join('\n')}\n${CUT_NOTICE}\n`
}

/** Deadline wording for moves involving these players: the earliest kickoff, an early game called out by its day. */
function deadline(view: ReportView, players: readonly FantasyPlayer[]): string {
  const kicks = players.flatMap(player => view.game(player)?.kickoff ?? [])
  if (kicks.length === 0) {
    const sunday = view.deadlines?.firstSunday
    return sunday === undefined ? 'before his game starts' : `before the first Sunday kickoff (${formatInstant(sunday, view.timezone)})`
  }
  const first = Math.min(...kicks)
  const early = view.deadlines?.firstSunday !== undefined && first < view.deadlines.firstSunday
  return `before ${early ? `the **${gameDay(first)} game**` : 'kickoff'} (${formatInstant(first, view.timezone)})`
}

/** Numbered checklist: lineup changes, IR moves, claims, adds and swaps, rechecks, and the final lineup deadline. */
function checklist(view: ReportView, name: (id: string) => string, player: (id: string) => FantasyPlayer): string[] {
  const items: string[] = []
  const changes = lineupChanges(view.lineup, view.players, view.slots)
  for (const id of changes.start) items.push(`Start ${name(id)} — ${deadline(view, [player(id)])}`)
  for (const id of changes.bench) items.push(`Bench ${name(id)} — ${deadline(view, [player(id)])}`)
  for (const id of view.moves.irMoves) items.push(`Move ${name(id)} to IR — now, so his roster spot opens`)
  const dropped = (pick: MovePick): string => pick.drop === undefined ? '' : `, dropping ${name(pick.drop)}`
  const deadlines = view.deadlines ?? { early: [] }
  for (const pick of view.moves.picks.filter(item => item.kind === 'claim')) {
    const fallback = pick.fallback === undefined ? '' : `; if the claim fails, add ${pick.fallback.player.name} instead`
    items.push(`Claim ${pick.candidate.player.name}${dropped(pick)} — ${claimTiming(deadlines)}${fallback}`)
  }
  for (const pick of view.moves.picks.filter(item => item.kind === 'free agent')) {
    const verb = SWAP_POSITIONS.has(pick.candidate.position) ? `Swap ${pick.candidate.position}: add` : 'Add'
    items.push(`${verb} ${pick.candidate.player.name}${dropped(pick)} — ${deadline(view,
      [pick.candidate.player, ...(pick.drop === undefined ? [] : [player(pick.drop)])])}`)
  }
  const reports = view.mode === 'sunday' ? 'the final injury report and inactives' : 'the Wednesday and Friday practice reports'
  for (const item of view.lineup) {
    if (item.player !== undefined && uncertain(player(item.player)) && player(item.player).slotLocked !== true) {
      items.push(`Recheck ${name(item.player)} (${player(item.player).status as string}) on ${reports} — ${deadline(view, [player(item.player)])}`)
    }
  }
  const sunday = view.deadlines?.firstSunday
  items.push(sunday === undefined ? 'Set the final lineup before each starter\'s kickoff'
    : `Set the final lineup before the first Sunday kickoff (${formatInstant(sunday, view.timezone)})`)
  return items.map((item, index) => `${index + 1}. ${item}`)
}

/** Game, implied total, and recent form marks of one player. */
function signalMarks(view: ReportView, player: FantasyPlayer): string[] {
  const marks: string[] = []
  const game = view.game(player)
  if (game !== undefined) {
    marks.push(`${game.home ? 'vs' : '@'} ${game.opponent} ${formatInstant(game.kickoff, view.timezone)}`)
    if (game.impliedTotal !== undefined) marks.push(`implied ${points(game.impliedTotal)}`)
  }
  const form = view.form.get(player.key)
  if (form?.average !== undefined) {
    marks.push(`recent ${form.points.map(item => points(item.points)).join(', ')} (avg ${points(form.average)}${
      form.flag === undefined ? '' : `, ${form.flag}`})`)
  }
  return marks
}

/** The moves section: waiver standing, IR moves, claims, adds, drops, and K or DEF swaps. */
function movesSection(view: ReportView, name: (id: string) => string): string[] {
  const { moves } = view
  if (!moves.enabled && moves.irMoves.length === 0) return []
  const lines = ['## Moves']
  const standing = [moves.waiverPriority === undefined ? undefined
    : `Waiver priority ${moves.waiverPriority}${moves.teams === undefined ? '' : ` of ${moves.teams}`}`,
  moves.faabBalance === undefined ? undefined : `FAAB $${moves.faabBalance}`,
  view.deadlines?.waiverDays === undefined ? undefined : `waiver period ${view.deadlines.waiverDays} days`]
    .filter(item => item !== undefined)
  if (standing.length > 0) lines.push(standing.join(' · ').replace(/^w/u, 'W'))
  for (const id of moves.irMoves) lines.push(`- **Move ${name(id)} to IR**: Yahoo lists him IR-eligible and an IR slot is empty.`)
  const pickLine = (pick: MovePick, label: string): string => {
    const player = pick.candidate.player
    const facts = [pick.candidate.position, player.nflTeam, `+${points(pick.net)} pts/wk over ${pick.weeks} wk`,
      pick.drop === undefined ? 'open roster spot' : `drop ${name(pick.drop)}`,
      player.percentOwned === undefined ? undefined : `${player.percentOwned}% owned`, ...signalMarks(view, player)]
    const fallback = pick.fallback === undefined ? ''
      : ` If the claim fails, add ${pick.fallback.player.name} (free agent, +${points(pick.fallback.value.net)} pts/wk).`
    return `- **${label} ${player.name}** · ${facts.filter(fact => fact !== undefined).join(' · ')} — ${pick.reason}${fallback}`
  }
  const swaps = moves.picks.filter(pick => SWAP_POSITIONS.has(pick.candidate.position))
  const adds = moves.picks.filter(pick => !swaps.includes(pick))
  for (const pick of adds.filter(item => item.kind === 'claim')) lines.push(pickLine(pick, 'Claim'))
  for (const pick of adds.filter(item => item.kind === 'free agent')) lines.push(pickLine(pick, 'Add'))
  const drops = adds.flatMap(pick => pick.drop === undefined ? [] : [pick.drop])
  if (drops.length > 0) {
    lines.push(`Drops: ${drops.map(id => `${name(id)} (costs ${points(moves.dropCosts.get(id))} pts/wk)`).join(', ')}`)
  }
  for (const pick of swaps) lines.push(pickLine(pick, `Swap ${pick.candidate.position}: ${pick.kind === 'claim' ? 'claim' : 'add'}`))
  if (moves.enabled && moves.picks.length === 0 && moves.irMoves.length === 0) {
    lines.push(`No suggested add raises the projected lineup over weeks ${view.weeks.join(', ')}.`)
  }
  lines.push('')
  return lines
}

function render(view: ReportView, detail: Detail): string {
  const sources = new Map(view.evidence.map(source => [source.id, source]))
  const cited = new Set<number>()
  const cite = (ids: readonly number[]): string => ids.map((id) => {
    cited.add(id)
    return `[${id}](<${(sources.get(id) as Evidence).url}>)`
  }).join(' ')
  const player = (id: string): FantasyPlayer => view.players.get(id) as FantasyPlayer
  const name = (id: string): string => player(id).name
  const lines = [`# ${view.teamName} · ${view.season} week ${view.week} ${MODE_TITLES[view.mode]}`,
    `**${formatInstant(view.firedAt, view.timezone)} · Yahoo roster and slots, weekly projections**`, '',
    '## Checklist', ...checklist(view, name, player), '']
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
    const starter = player(id)
    const marks = [starter.nflTeam, `proj ${points(starter.projectedPoints)}`,
      starter.status === undefined ? undefined : `Yahoo ${starter.status}${starter.injuryNote === undefined ? '' : ` (${starter.injuryNote})`}`,
      starter.slotLocked === true ? 'locked' : undefined,
      changes.start.includes(id) ? `**start** (Yahoo ${starter.selectedSlot ?? 'BN'})` : undefined, ...signalMarks(view, starter)]
    lines.push(`- **${slot}** ${starter.name} · ${marks.filter(mark => mark !== undefined).join(' · ')}`)
  }
  const bench = [...view.players].filter(([id]) => !view.lineup.some(item => item.player === id))
  if (bench.length > 0) {
    lines.push('', `Bench: ${bench.map(([, reserve]) => `${reserve.name}${reserve.status === undefined ? '' : ` (${reserve.status})`}`
      + (reserve.slotLocked === true ? ' (locked)' : '')).join(', ')}`)
  }
  lines.push('', ...movesSection(view, name))
  if (detail !== 'minimal' && view.byes.length > 0) {
    lines.push('## Bye outlook')
    for (const week of view.byes) {
      const bye = week.bye.length === 0 ? 'no byes' : `on bye ${week.bye.map(name).join(', ')}`
      const empty = week.empty.length === 0 ? 'every starting slot can be filled' : `nobody can fill ${week.empty.join(', ')}`
      lines.push(`- Week ${week.week}: ${bye}; ${empty}`)
    }
    lines.push('')
  }
  if (detail !== 'minimal') {
    if (view.chip !== undefined) {
      const { chip } = view
      lines.push('## Trade chip', `**${name(chip.id)}** (${chip.position}) — ${chip.healthy} healthy players at ${chip.position} for ${chip.need} `
        + `starting slot${chip.need === 1 ? '' : 's'} and a bye cover; averages ${points(chip.average)} projected over weeks `
        + `${view.weeks.join(', ')}.`, '')
    }
  }
  if (view.since !== undefined) {
    lines.push(`## Since the ${MODE_TITLES[view.since.mode]}`,
      ...(view.since.lines.length === 0 ? ['- No Yahoo status, roster, or move changes.'] : view.since.lines.map(line => `- ${line}`)), '')
  }
  lines.push('## Player calls')
  for (const [id, rostered] of view.players) {
    const call = view.calls.get(id) as PlayerCall
    const facts = [rostered.positions.filter(position => !position.includes('/') && position !== 'IR').join('/'), rostered.nflTeam,
      rostered.byeWeek === undefined ? undefined : `bye ${rostered.byeWeek}`, call.origin === 'model' ? undefined : 'code reason']
    lines.push(`**${rostered.name} — ${call.call}** · ${facts.filter(fact => fact !== undefined).join(' · ')}`)
    if (detail === 'full' || call.call === 'START' || call.call === 'FLEX') lines.push(`${call.reason} ${cite(call.sources)}`.trim())
    lines.push('')
  }
  if (view.comparisons.length > 0) {
    lines.push('## Close calls')
    for (const { pair, text, sources: refs } of view.comparisons) {
      lines.push(`**${name(pair.starter)} or ${name(pair.bench)}** (${pair.slot})`, `${text} ${cite(refs)}`.trim(), '')
    }
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
