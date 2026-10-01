# Agent Note: Sleeper projections for fantasy reports

Status: implemented

English | [中文](2026-10-01-fantasy-sleeper-projections.zh.md)

## Problem

The weekly fantasy report ranks lineups, close calls, and waiver gaps by `FantasyPlayer.projectedPoints`, but Yahoo's public Fantasy API returns no per-player projections: weekly roster reads carry actual stats and only team totals carry projections, and every projected-stats request variant is refused. Live reports would therefore show no player projections, keep current Yahoo starters, and flag close calls only from uncertain starters.

## Decision

`dsh-fantasy` gains a second Service Definition, `FantasyProjectionService` (`ctx.fantasyProjections`), with one method, `project(season, week, players, signal)`, that returns projected stat lines keyed by player key in the stat ids of `FantasyScoringStat.id`; unmatched players are absent. The pure `scoreStats(stats, scoring)` scores a line under league scoring. Lines rather than points keep league scoring with the league provider and let any consumer score them.

`dsh-fantasy-projections-sleeper` provides it from Sleeper's free public endpoint, one GET per season and week, cached for `cacheTtlMs` and shared by concurrent callers. A fixed protocol table translates Sleeper stat keys to Yahoo stat ids; defenses use their own table, so a defense row's `pr_td` never doubles its return touchdowns, and a row without a points-allowed tier flag gets the tier containing its `pts_allow`. Players match by normalized name and uppercase NFL team, then by a unique last name, team, and position; defenses match by team. Against Sleeper's week 5 2026 response, 384 of 416 Yahoo players in one league matched, the misses being unlisted backups and kickers, and every matched non-kicker, non-defense line scored within one point of Sleeper's half-PPR total under that league's scoring.

`dsh-fantasy-reports` requires `fantasyProjections` and projects the roster, each free-agent list, and the opponent's roster with one call per list, setting `projectedPoints` only where Yahoo left it undefined. A failed projection read adds a caveat and leaves that list unprojected. Player-level report and prompt text says "projected" instead of "Yahoo projects"; team totals stay Yahoo's. The prompt version stays `fantasy-weekly-v6` because v6 is unreleased.

## Alternatives considered

- **Request projections from Yahoo with other stat types** — rejected because every projected-stats variant returned HTTP 400 in live checks.
- **Return projected points instead of stat lines** — rejected because points depend on league scoring, which the league provider owns, and each consumer would need the provider to know it.
- **Scrape a projections site such as FantasyPros** — rejected because Sleeper's JSON endpoint needs no HTML parsing or key and carries full stat lines.
- **Make the projection service optional in the report** — rejected because a report without projections silently degrades every lineup decision; a required injection fails loud when the provider row is missing.

## Consequences

Live reports rank lineups and waiver gaps by projections, and projection close calls can arise. The report depends on an undocumented public endpoint; a changed shape fails the read, which the report discloses as a caveat. Projected points come from Sleeper while matchup totals come from Yahoo, so the slot comparison need not add up to the matchup line. Deployments that load the report must also enable the provider row; the Beardy bundle ships it disabled beside the report row.
