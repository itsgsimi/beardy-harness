---
description: "The research package group: durable run records, a local engine, and a model-facing tool."
kind: "package-group"
---

# packages/research

English | [中文](README.zh.md)

## Summary

Research runs survive a process restart and retain owner-scoped progress and reports. The definition supplies service and Session event types, the local provider runs the bounded Web and model engine, and the tool exposes five actions to a caller model.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`research`](research/README.md) | Run identity, owner, report, event, and service types | `ctx.research` |
| [`research-local`](research-local/README.md) | Persists, lists, and reconciles runs and report attachments | provider for `ctx.research` |
| [`tool-research`](tool-research/README.md) | Exposes `deep_research` actions and paged reports | consumer of `ctx.research` |
| [`client-ui-research`](client-ui-research/README.md) | Web report dialog for research calls and the research worker Settings tab | browser plugin |

-----

<a id="related-documentation"></a>
## Related documentation

- [Research subsystem](../../docs/subsystems/research.md) — run state and event relationships.
- [Session-backed research decision](../../.agents/notes/implemented/feature/2026-09-27-session-backed-research-runs.md) — ownership and recovery rationale.

-----

<a id="dev-note"></a>
## Dev Note

None.
