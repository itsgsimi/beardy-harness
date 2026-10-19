/**
 * What changed since an earlier report of the same week: Yahoo status changes, roster arrivals and
 * departures, and IR, claim, and free-agent moves the earlier report did not suggest. The earlier report's
 * facts come from its saved evidence file, which this module parses and checks.
 * @module @deepseek-ai/dsh-fantasy-reports/since
 */

/** Roster and suggested moves as one report recorded them, keyed by Yahoo player key. */
export interface ReportFacts {
  readonly roster: ReadonlyArray<{ readonly key: string; readonly name: string; readonly status?: string }>
  /** Suggested moves by kind, as player keys. */
  readonly moves: { readonly ir: readonly string[]; readonly claims: readonly string[]; readonly adds: readonly string[] }
  /** Display names of every player the moves name, by key. */
  readonly names: Readonly<Record<string, string>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function keys(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/**
 * Parse the facts of an earlier report from its evidence JSON. Evidence written before suggested moves were
 * recorded has a roster and no moves.
 * @param evidence - evidence file text.
 * @returns the roster and moves, or undefined when the text is not report evidence with a Yahoo roster.
 */
export function parseReportFacts(evidence: string): ReportFacts | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(evidence)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || !isRecord(parsed.yahoo) || !isRecord(parsed.yahoo.roster) || !Array.isArray(parsed.yahoo.roster.players)) {
    return undefined
  }
  const roster = parsed.yahoo.roster.players.flatMap(player => isRecord(player) && typeof player.key === 'string'
    && typeof player.name === 'string'
    ? [{ key: player.key, name: player.name, ...(typeof player.status === 'string' ? { status: player.status } : {}) }] : [])
  const moves = isRecord(parsed.moves) ? parsed.moves : {}
  const names = isRecord(moves.names) ? Object.fromEntries(Object.entries(moves.names)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}
  return { roster, moves: { ir: keys(moves.ir), claims: keys(moves.claims), adds: keys(moves.adds) }, names }
}

/**
 * Describe what changed between an earlier report of the week and this one.
 * @param earlier - facts of the earlier report.
 * @param current - facts of this report.
 * @returns one line per change, statuses first, then roster changes, then new moves; empty when nothing changed.
 */
export function changesSince(earlier: ReportFacts, current: ReportFacts): string[] {
  const before = new Map(earlier.roster.map(player => [player.key, player]))
  const now = new Set(current.roster.map(player => player.key))
  const lines: string[] = []
  for (const player of current.roster) {
    const old = before.get(player.key)
    if (old !== undefined && old.status !== player.status) {
      lines.push(`${player.name}: Yahoo status ${old.status ?? 'none'} → ${player.status ?? 'none'}`)
    }
  }
  const arrived = current.roster.filter(player => !before.has(player.key)).map(player => player.name)
  if (arrived.length > 0) lines.push(`New on the roster: ${arrived.join(', ')}`)
  const left = earlier.roster.filter(player => !now.has(player.key)).map(player => player.name)
  if (left.length > 0) lines.push(`No longer on the roster: ${left.join(', ')}`)
  const fresh = (kind: keyof ReportFacts['moves'], label: string): void => {
    const added = current.moves[kind].filter(key => !earlier.moves[kind].includes(key)).map(key => current.names[key] ?? key)
    if (added.length > 0) lines.push(`${label}: ${added.join(', ')}`)
  }
  fresh('ir', 'New IR moves')
  fresh('claims', 'New waiver claims')
  fresh('adds', 'New free-agent adds')
  return lines
}
