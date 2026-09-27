---
description: "The research package group: durable run records and local storage for a native research engine and its future consumers."
kind: "package-group"
---

# packages/research

English | [中文](README.zh.md)

## Summary

Research runs can survive a process restart and retain owner-scoped progress and reports. The definition package supplies the public service and Session event types; the local provider stores runs and immutable report files. A model engine and tool consumer are separate additions.

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

-----

<a id="related-documentation"></a>
## Related documentation

- [Research subsystem](../../docs/subsystems/research.md) — run state and event relationships.
- [Session-backed research decision](../../.agents/notes/implemented/feature/2026-09-27-session-backed-research-runs.md) — ownership and recovery rationale.

-----

<a id="dev-note"></a>
## Dev Note

None.
