---
description: "Inbound Discord conversations: a gateway websocket that turns direct messages from allowlisted users into DSH sessions and posts each answer back to the channel it came from, for users who want to work with an agent from Discord."
kind: "package-reference"
---

# @deepseek-ai/dsh-discord-gateway

English | [中文](README.zh.md)

## Summary

The package lets a person converse with a DSH agent from Discord. It holds one Gateway v10 websocket, identifies with the bot token resolved from a credential reference, and reads `MESSAGE_CREATE` events: a direct message from a user in `allowedUserIds` — or a post in an allowlisted guild channel — opens a session on this Host, mounts the configured agent preset and permission preset in the configured workspace, hands the text over as a normal user message carrying Discord provenance, and posts the agent's answer back to the channel it came from. Each channel keeps one session, so follow-up messages continue the same conversation and appear in the Web UI beside every other session. Reconnects double the delay up to a ceiling; `enabled: false` mounts the plugin without dialing out.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="model-experience"></a>
## Model Experience

### Inbound message

#### What the model sees

Each inbound Discord message arrives as one user-role message whose text is the message body, bounded by `maxInputChars`. The message carries provenance the surfaces render as a notice: the sender's Discord user id, the channel id, the message id, and a summary naming the channel. Nothing else about Discord reaches the model — no member roles, no attachment metadata, no other messages in the channel — so an agent learns the channel's earlier content only from the session history this package already appended.

#### Token effect

One user message per inbound Discord message, plus the reply's tool-call and result messages when the agent answers through `@deepseek-ai/dsh-tool-discord`. Conversation history grows like any other session; nothing is re-sent that the log already holds.

#### KV Cache effect

Inbound messages append to an existing session, so earlier turns stay reusable and only the new message and following turns form a fresh suffix. A channel's first message creates a session whose preset composition forms the initial prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Guild channels need a privileged portal toggle** — the package identifies with `GUILD_MESSAGES | DIRECT_MESSAGES` only, so guild-channel bodies arrive empty until Message Content intent is enabled for the application in the Discord developer portal. Direct messages are exempt and arrive complete.
- **Conversation continuity is process-local** — the channel-to-session map lives in memory, so a restart starts each channel on a new session instead of resuming the previous one.
- **One Host per bot token** — two processes identifying with the same token both receive every event and both reply; run the gateway in exactly one process.
- **Text only** — attachments, embeds, replies, and reactions are ignored, and long inbound text is truncated at `maxInputChars` rather than split across turns.
- **No progress feedback in Discord** — the package posts nothing while a turn runs: no typing indicator, no acknowledgement of receipt, and no message when a turn times out or fails.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`gateway.ts` owns the websocket lifecycle (identify, heartbeat, resume, reconnect backoff) and reports status through `onStatus`; `conversation.ts` owns session creation, per-channel serialization through a tail promise, and delivery. Outbound posts reuse `sendDiscordMessage` from `@deepseek-ai/dsh-tool-discord`, so the 2000-character chunking and mention rewriting live in one place. Tests drive both halves with a fake socket and a fake agent; no test opens a real Discord connection.

</details>

**Runtime invariant:** No companion is published. The websocket, timers, and per-channel sessions belong to the plugin fiber and are closed when it stops; `tests/index.spec.ts` covers connect, disconnect, and teardown.
