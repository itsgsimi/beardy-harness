---
description: "nflverse NFL schedules, betting lines, and completed-game usage for Fantasy consumers."
kind: "package-reference"
---

# @deepseek-ai/dsh-fantasy-nflverse

English | [中文](README.zh.md)

## Summary

Use `ctx.fantasyNfl` to read each regular-season week's NFL games, with kickoff times, point spreads, totals, and roofs, and league players' completed-game usage: targets, target share, receptions, carries, and offensive snap share. The provider reads nflverse's public CSV files, needs no account or key, and matches league players by name, NFL team, and position.

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

Mount the provider beside a Fantasy provider such as [fantasy-yahoo](../fantasy-yahoo/README.md). Every field has a default, so an empty `config` works. URLs must be HTTPS without credentials, and both templates must contain `{season}`, which is replaced by the season year; a URL that fails these checks fails the plugin at load.

| Config | Default | Meaning |
|---|---|---|
| `scheduleUrl` | `https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv` | All-seasons schedule CSV |
| `statsUrlTemplate` | `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_{season}.csv` | One season's weekly player stats CSV |
| `snapsUrlTemplate` | `https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_{season}.csv` | One season's snap counts CSV |
| `cacheTtlMs` | `21600000` | How long one file is reused after its request starts, from `0` (request every time) through 24 hours |
| `requestTimeoutMs` | `60000` | Deadline of each request, including reading its body |
| `maxResponseBytes` | `20971520` | Largest accepted body; a larger body fails its request |

`games(season, week)` returns the week's regular-season games in schedule order; teams on bye are absent. `kickoff` is an ISO 8601 UTC timestamp, `homeSpread` is the points the home team is favored by, and `total` is the over/under. Team abbreviations are uppercase and match Yahoo's, so the Rams are `LAR`. A line or roof the schedule leaves blank is absent.

`usage(season, weeks, players)` returns, for each matched player, one row per requested week in which he has a stats or snap row, in week order. A row carries `week`, `team`, `opponent`, and whichever of `targets`, `targetShare`, `receptions`, `carries`, and `snapShare` the files report; shares run from 0 to 1. Kickers, defenses, and unmatched players are absent.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The schedule is one file of every season, about 2.2 MB; weekly stats, about 2.9 MB, and snap counts, about 0.7 MB, are one file per season. The provider keeps one request per URL for `cacheTtlMs`; concurrent callers share the in-flight request, a failed request is forgotten so the next caller retries, and one caller's cancellation rejects only that caller. A request fails on a transport error, a non-success status, a redirect to a non-HTTPS URL, a body over `maxResponseBytes`, or a file missing a required column; errors name the file and status, never the body.

`papaparse` reads each file with its header row and skips blank lines. Only regular-season rows count: schedule and snap rows with `game_type` `REG`, stats rows with `season_type` `REG`. A schedule row without a season, week, team, or `YYYY-MM-DD` date and `HH:MM` time is skipped. The schedule writes times in US Eastern wall-clock time, so the kickoff conversion applies the `America/New_York` offset in effect on that date through `Intl`, and a game after the November daylight-saving change gets the standard-time offset. `spread_line` becomes `homeSpread`, `total_line` becomes `total`, and nflverse's `LA` becomes `LAR`.

Names are matched through `normalizePlayerName` from [fantasy](../fantasy/README.md). For each week, a player matches the single stats row with his normalized name, one of his positions, and his NFL team; when no row of that week has his team, as after a trade, the single row with his name and one of his positions. Snap rows match the same way, by `player`, `position`, and `team`, and supply `snapShare` from `offense_pct`. Team and opponent come from the stats row, or from the snap row when the week has no stats row. No invariant companion is published because the cache is derived from nflverse responses and owns no independent observation.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Fantasy definitions](../fantasy/README.md) — `FantasyNflService`, `FantasyNflGame`, and `FantasyNflUsage`.
- [Weekly reports](../fantasy-reports/README.md) — the NFL data consumer.

-----

<a id="model-experience"></a>
## Model Experience

### nflverse NFL data provider

#### What the model sees

The provider registers no schema or prompt. Consumers turn games and usage into report facts before any model sees them, such as implied team totals computed from `homeSpread` and `total`, and `snapShare` values.

#### Token effect

The provider adds no model tokens by itself.

#### KV Cache effect

The provider does not alter model request caching. Its file cache is separate.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- nflverse publishes stats and snap counts after games finish, and snap counts can lag stats by a week; a week without a file row is absent or lacks `snapShare`.
- The files are public and community-maintained; a renamed column fails the request rather than producing wrong rows.
- Namesakes on the same NFL team and position, and players whose positions differ between Yahoo and nflverse, such as a fullback listed as a running back, stay unmatched.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
