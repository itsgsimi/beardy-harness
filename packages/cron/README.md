---
description: "The cron group map: a Host-scoped scheduler that runs configured jobs as fresh unattended sessions on a wall-clock timetable, for operators who want an agent to act without being asked."
kind: "package-group"
---

# cron/ — unattended scheduled agent runs

English | [中文](README.zh.md)

## Summary

The cron group runs agents on a timetable with nobody present. Jobs are declared in configuration — a cron expression, an IANA timezone, a prompt, and the agent-preset and permission-preset pair that shape the run — and each fire opens its own Session, so the run is searchable and its log reconstructs every step afterwards. Configuration is validated at load: duplicate job names, unusable expressions or timezones, and relative workspace paths stop startup instead of leaving a job that never fires. The group delivers nothing; a run reaches the outside world through whatever tools its preset mounts, such as [`discord_send`](../discord/tool-discord/README.md). Session-scoped reminders with durable rules belong to [`dsh-schedule`](../schedule/schedule/README.md), not here.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`cron/`](cron/README.md) | Mounts configured cron jobs and opens one unattended Session per fire | consumes `ctx.agents`, `ctx.agentPresets`, `ctx.permissionPresets`, `ctx.workspaceRegistry`, `ctx.sessionTitle` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Host-scoped cron with Discord delivery Agent Note](../../.agents/notes/implemented/feature/2026-09-05-host-cron-with-discord-delivery.md) — why the host scheduler is separate from `dsh-schedule`, and what it defers.
