---
description: "The Discord group map: one model-facing send tool over the REST API and one gateway listener that turns direct messages into sessions, for users wiring an agent to a Discord channel or working with it from Discord."
kind: "package-group"
---

# discord/ — Discord delivery and conversations

English | [中文](README.zh.md)

## Summary

The Discord group connects an agent to Discord in both directions with two independent packages. Delivery is one model-facing `discord_send` tool that posts to a configured channel or to an allowlisted user's direct messages, splitting long bodies and rewriting broadcast mentions; it speaks the REST API directly and holds no Discord state. Conversations run the other way: a gateway websocket reads direct messages from allowlisted users, opens a session per channel on the Host, and posts each answer back where the message came from. Either half can be mounted alone — delivery needs only a credential provider, and inbound conversation reuses the same delivery path for its replies. Both resolve the bot token from a credential reference, so no token appears in a composition file, and exactly one process may identify with a given bot token.

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
