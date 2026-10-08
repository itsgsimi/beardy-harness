---
description: "The visuals package group: Web views for visual snapshots that the agent delivers during a turn."
kind: "package-group"
---

# packages/visuals

English | [中文](README.zh.md)

## Summary

Beardy shows charts, images, and HTML mockups delivered by `present_visual` inline in the Web conversation, at the position where the delivery was recorded. The group holds the browser plugin; the tool and its persisted `visual` field live in [`deliverables/tool-present`](../deliverables/tool-present/README.md).

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`client-ui-visuals`](client-ui-visuals/README.md) | Inline Chat node for delivered visual snapshots | browser plugin |

-----

<a id="related-documentation"></a>
## Related documentation

- [Deliverables subsystem](../../docs/subsystems/deliverables.md) — the `deliverables/presented` event and its file declarations.
- [Downstream carry decision](../../.agents/notes/implemented/architecture/2026-10-07-downstream-carry-into-plugins.md) — why Beardy views live in Beardy packages.

-----

<a id="dev-note"></a>
## Dev Note

None.
