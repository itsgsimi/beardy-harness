---
description: "Read-only Fantasy and projection service types, stat-line scoring, and branded league, team, and player keys."
kind: "package-reference"
---

# @deepseek-ai/dsh-fantasy

English | [中文](README.zh.md)

## Summary

Use `ctx.fantasy` to read leagues, scoring rules, standings, matchups, rosters, players, transactions, draft picks, and game weeks. A provider supplies the data; the definition validates league, team, and player keys before they enter provider paths. Use `ctx.fantasyProjections` to project weekly stat lines for league players, and `scoreStats` to score a stat line under league scoring. Use `ctx.fantasyNfl` to read NFL games, betting lines, and completed-game usage, and `normalizePlayerName` to match player names across sources.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount a provider such as [fantasy-yahoo](../fantasy-yahoo/README.md) before a consumer calls the service. A live caller Session selects its configured team through `teamFor`; model arguments never choose a caller identity.

`players(league, query)` reads one page. `status` `FA` selects immediate adds, `W` waiver claims, and `A` both; each player's `ownershipType` is `team`, `waivers`, or `freeagents`. `playerKeys` reads at most 25 exact players and excludes `search`, `status`, `position`, and `sort`; `week` still selects the stats week. `percentOwnedDelta` is the change in percent owned. `FantasyTeam` carries `waiverPriority` (1 claims first), `faabBalance` in leagues with a budget, and `moves`, the season count of adds and drops. `FantasyLeagueSettings` carries `waiverDays` and `usesFaab`. `positions` includes `IR` when the league lets the player occupy an IR slot now.

Mount a projection provider such as [fantasy-projections-sleeper](../fantasy-projections-sleeper/README.md) before a consumer calls `ctx.fantasyProjections.project(season, week, players)`. It returns projected stat lines keyed by player key, using the stat ids of `FantasyScoringStat.id` and `FantasyPlayer.stats`; players it cannot match are absent. `scoreStats(line, scoring)` sums each stat times its scoring value over the entries that carry a value, rounded to hundredths.

Mount an NFL data provider such as `@deepseek-ai/dsh-fantasy-nflverse` before a consumer calls `ctx.fantasyNfl`. `games(season, week)` returns that week's `FantasyNflGame` rows with UTC kickoff, home and away teams, and the home spread, total, and roof when published; teams on bye are absent. `usage(season, weeks, players)` returns `FantasyNflUsage` rows by player key in week order, with targets, target share, receptions, carries, and snap share; unmatched players and unplayed games are absent. Team abbreviations are uppercase and match `FantasyPlayer.nflTeam` compared case-insensitively. `normalizePlayerName(name)` folds accents to ASCII, lowercases, removes periods and apostrophes, drops `Jr`, `Sr`, and `II` through `V`, and joins the remaining words with single spaces.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The abstract services declare provider-neutral read and projection methods and view types. League, team, and player keys are branded strings admitted by exact Yahoo key shapes. No invariant companion is published because the definition owns no mutable state or independent observations.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Fantasy subsystem](../../../docs/subsystems/fantasy.md) — data relationships and authority.
- [Model tool](../tool-fantasy/README.md) — bounded model results.

-----

<a id="model-experience"></a>
## Model Experience

### Fantasy service

#### What the model sees

This definition registers no schema or prompt. The `fantasy` consumer selects read views for the caller Session; `ctx.fantasy` itself remains on the Host.

#### Token effect

The definition adds no model tokens.

#### KV Cache effect

The definition does not alter request caching.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A provider is required to answer any read, a projection provider to answer any projection, and an NFL data provider to answer any NFL data read.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
