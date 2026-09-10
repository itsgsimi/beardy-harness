---
description: "The cron group map: a Host-scoped scheduler that runs configured jobs as fresh unattended sessions on a wall-clock timetable, for operators who want an agent to act without being asked."
kind: "package-group"
---

# cron/ — unattended scheduled agent runs

English | [中文](README.zh.md)

## Summary

The cron group runs agents on a timetable with nobody present. Jobs come from configuration or durable runtime management through `cron_manage` and `/cron`. Each accepted fire opens a fresh Session using its schedule, timezone, prompt, presets, workspace, and current continuity notes. Durable reservations and outcomes distinguish unfinished work after restart; finished text waits for a delivery listener such as the [Discord gateway](../discord/discord-gateway/README.md). The [cron package](cron/README.md) owns configuration, recovery, and delivery details. Session-scoped reminders belong to [`dsh-schedule`](../schedule/schedule/README.md).

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`cron/`](cron/README.md) | Manages configured and stored jobs, runs unattended Sessions, and retains outcomes until delivery acceptance | consumes `ctx.agents`, `ctx.agentPresets`, `ctx.permissionPresets`, `ctx.workspaceRegistry`, `ctx.sessionTitle` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Cron subsystem reference](../../docs/subsystems/cron.md) — run results and the delivery acknowledgment event.
- [Host-scoped cron with Discord delivery Agent Note](../../.agents/notes/implemented/feature/2026-09-05-host-cron-with-discord-delivery.md) — why the host scheduler is separate from `dsh-schedule`, and what it defers.
