---
description: "Read-only Fantasy and projection service types, stat-line scoring, and branded league, team, and player keys."
kind: "package-reference"
---

# @deepseek-ai/dsh-fantasy

English | [中文](README.zh.md)

## Summary

Use `ctx.fantasy` to read leagues, scoring rules, standings, matchups, rosters, players, transactions, draft picks, and game weeks. A provider supplies the data; the definition validates league, team, and player keys before they enter provider paths. Use `ctx.fantasyProjections` to project weekly stat lines for league players, and `scoreStats` to score a stat line under league scoring.

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

Mount a projection provider such as [fantasy-projections-sleeper](../fantasy-projections-sleeper/README.md) before a consumer calls `ctx.fantasyProjections.project(season, week, players)`. It returns projected stat lines keyed by player key, using the stat ids of `FantasyScoringStat.id` and `FantasyPlayer.stats`; players it cannot match are absent. `scoreStats(line, scoring)` sums each stat times its scoring value over the entries that carry a value, rounded to hundredths.

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

- A provider is required to answer any read, and a projection provider to answer any projection.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
