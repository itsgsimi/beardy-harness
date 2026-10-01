---
description: "Yahoo Fantasy read-only service, provider, and model tool."
kind: "package-group"
---

# packages/fantasy

English | [中文](README.zh.md)

## Summary

Read current Yahoo Fantasy league and team facts through one service and weekly player projections through another. The Yahoo provider owns a private OAuth store; the Sleeper provider supplies projected stat lines; the model tool exposes bounded, logged read results; the report plugin sends scheduled, reviewed weekly reports.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [fantasy](fantasy/README.md) | Branded keys, read views, and projection scoring | `ctx.fantasy` and `ctx.fantasyProjections` definitions |
| [fantasy-yahoo](fantasy-yahoo/README.md) | Yahoo v2 API and private OAuth store | `ctx.fantasy` provider |
| [fantasy-projections-sleeper](fantasy-projections-sleeper/README.md) | Sleeper weekly stat-line projections | `ctx.fantasyProjections` provider |
| [tool-fantasy](tool-fantasy/README.md) | Bounded `fantasy` model tool | service consumer |
| [fantasy-reports](fantasy-reports/README.md) | Scheduled weekly reports through research runs | service consumer |

-----

<a id="related-documentation"></a>
## Related documentation

- [Fantasy subsystem](../../docs/subsystems/fantasy.md) — reads, ownership, and caller team resolution.

-----

<a id="dev-note"></a>
## Dev Note

None.
