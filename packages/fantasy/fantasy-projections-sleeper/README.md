---
description: "Sleeper weekly stat-line projections translated to Yahoo stat ids for Fantasy consumers."
kind: "package-reference"
---

# @deepseek-ai/dsh-fantasy-projections-sleeper

English | [中文](README.zh.md)

## Summary

Use `ctx.fantasyProjections` to project league players' weekly stat lines from Sleeper's public projections. The provider needs no account or key, translates Sleeper stat keys to Yahoo stat ids, and matches league players by name, NFL team, and position, so a consumer can score each line under its league scoring with `scoreStats`.

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

Mount the provider beside a Fantasy provider such as [fantasy-yahoo](../fantasy-yahoo/README.md). Every field has a default, so an empty `config` works.

| Config | Default | Meaning |
|---|---|---|
| `baseUrl` | `https://api.sleeper.com` | HTTPS origin of the projections endpoint |
| `seasonType` | `regular` | Sleeper season type: `regular`, `pre`, or `post` |
| `positions` | `QB`, `RB`, `WR`, `TE`, `K`, `DEF` | Positions requested; rows with none of them never match |
| `cacheTtlMs` | `3600000` | How long one week's projections are reused after the request starts; `0` requests every time |
| `requestTimeoutMs` | `20000` | Deadline of each Sleeper request |

`project(season, week, players)` returns a stat line for each matched player with at least one projected stat, keyed by player key. Players without a match, such as deep backups Sleeper does not list, and players whose row projects nothing, such as players on bye, are absent.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One GET of `/projections/nfl/<season>/<week>` returns every projected row of the week, about 3,300 rows and 2 MB. The provider keeps one request per season and week for `cacheTtlMs`; concurrent callers share the in-flight request, a failed request is forgotten so the next caller retries, and one caller's cancellation rejects only that caller. A body that is not an array fails the request; rows without a player name, position, team, or stats object are skipped, and non-numeric stats are dropped.

A fixed protocol table translates Sleeper keys to Yahoo stat ids. Offensive players and kickers map passing, rushing, receiving, targets, lost fumbles, field goals and misses by distance, and extra points; `pr_td` plus `kr_td` become return touchdowns (15) and the three two-point keys sum into 16. Defenses map points allowed, sacks, interceptions, fumble recoveries, defensive touchdowns, safeties, and blocked kicks; `def_pr_td` plus `def_kr_td`, or `st_td` when both are absent, become return touchdowns (49); Sleeper's points-allowed tier flags map to 50 through 56, and a row without any tier flag gets the tier that contains its `pts_allow`.

Names are matched after NFKD normalization to ASCII, lowercasing, removing periods and apostrophes, dropping `jr`, `sr`, `ii`, `iii`, `iv`, and `v`, and collapsing other separators. A player matches the single row with the same normalized name and uppercase NFL team; failing that, the single row with the same last name, team, and one of the player's positions. A defense matches the single defense row of its team. No invariant companion is published because the cache is derived from Sleeper responses and owns no independent observation.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Fantasy definitions](../fantasy/README.md) — `FantasyProjectionService` and `scoreStats`.
- [Weekly reports](../fantasy-reports/README.md) — the projection consumer.

-----

<a id="model-experience"></a>
## Model Experience

### Sleeper projection provider

#### What the model sees

The provider registers no schema or prompt. Consumers turn stat lines into projected points with `scoreStats` before any model sees them, such as the `projection` field of a weekly report's fact sheet.

#### Token effect

The provider adds no model tokens by itself.

#### KV Cache effect

The provider does not alter model request caching. Its projection cache is separate.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Sleeper's projections endpoint is public and undocumented; a changed response shape fails the request or drops rows rather than producing wrong lines.
- Yahoo stats without a Sleeper key, such as offensive fumble-return touchdowns, are absent from lines; Sleeper's week 5 2026 response carried no `kr_td`, `fgmiss_0_19`, or `fgmiss_20_29` key and only the `pts_allow_21_27` tier flag.
- Players Sleeper does not list, and namesakes on the same NFL team and position, stay unprojected.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
