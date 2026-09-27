---
description: "Yahoo Fantasy read-only service, provider, and model tool."
kind: "package-group"
---

# packages/fantasy

English | [中文](README.zh.md)

## Summary

Read current Yahoo Fantasy league and team facts through one service. The Yahoo provider owns a private OAuth store; the model tool exposes bounded, logged read results.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [fantasy](fantasy/README.md) | Branded keys and read views | `ctx.fantasy` definition |
| [fantasy-yahoo](fantasy-yahoo/README.md) | Yahoo v2 API and private OAuth store | `ctx.fantasy` provider |
| [tool-fantasy](tool-fantasy/README.md) | Bounded `fantasy` model tool | service consumer |

-----

<a id="related-documentation"></a>
## Related documentation

- [Fantasy subsystem](../../docs/subsystems/fantasy.md) — reads, ownership, and caller team resolution.

-----

<a id="dev-note"></a>
## Dev Note

None.
