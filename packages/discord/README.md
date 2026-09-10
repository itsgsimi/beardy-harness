---
description: "The Discord group map: one model-facing send tool over the REST API and one gateway listener that turns direct messages into sessions, for users wiring an agent to a Discord channel or working with it from Discord."
kind: "package-group"
---

# discord/ — Discord delivery and conversations

English | [中文](README.zh.md)

## Summary

The Discord group connects an agent in both directions through two independent packages. The model-facing `discord_send` tool posts to a configured channel or an allowlisted user's direct messages, splitting long bodies and neutralizing broadcast mentions through the REST API. The gateway reads allowlisted direct messages, opens one Host session per channel, and sends answers through the same delivery path. Either half can run alone. Both resolve the bot token from a credential reference, and only one process may identify with a given token.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`tool-discord/`](tool-discord/README.md) | Model-facing `discord_send` tool posting over the Discord REST API with chunking and mention rewriting | registers on `ctx.tools` |
| [`discord-gateway/`](discord-gateway/README.md) | Gateway v10 listener that turns direct messages from allowlisted users into Host sessions and answers them in place | consumes `ctx.agents`, `ctx.agentPresets`, `ctx.permissionPresets`, `ctx.workspaceRegistry` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Host-scoped cron with Discord delivery Agent Note](../../.agents/notes/implemented/feature/2026-09-05-host-cron-with-discord-delivery.md) — why delivery and inbound conversation are separate packages, and what each defers.
- [`dsh-cron`](../cron/cron/README.md) — the scheduler that drives unattended runs whose output these packages deliver.
