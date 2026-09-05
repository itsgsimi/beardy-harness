---
description: "Model-facing Discord delivery over the raw REST API: one channel-bound send tool with chunking, rate-limit waits, and broadcast-mention rewriting, for users wiring agent output into a Discord channel."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-discord

English | [中文](README.zh.md)

## Summary

The package gives an agent one way to write into Discord: the `discord_send` tool posts a message to the channel named in configuration, or to a direct-message channel with an allowlisted user when `dmUserIds` lists ids. It speaks the Discord REST API directly — no SDK, no gateway connection, no cached Discord state — and resolves the bot token from a credential reference at send time. Bodies longer than Discord's 2000-character limit are split into consecutive messages, HTTP 429 replies are waited out up to a configured ceiling, and `@everyone`, `@here`, and role pings in the body are rewritten before posting so an agent cannot broadcast to a guild. Mount it beside a credential provider; the plugin registers nothing else.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`discord_send` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-discord): a required `content` string, plus a `recipient` user-id parameter that appears only when `dmUserIds` is non-empty. The tool description names the destination channel id and states that other channels cannot be selected. The result reports the channel the post landed in, how many messages it took, the character count, and how many broadcast mentions were rewritten.

#### Token effect

Fixed schema cost per request where the tool is visible. Each call adds one tool-call and one tool-result message to the session log; the posted body appears in the log once, as the argument.

#### KV Cache effect

Prefix-stable while the tool definition and visibility are unchanged. Shadowing, a configuration change that adds or removes `recipient`, or plugin lifecycle changes may invalidate reuse from this schema.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One destination per mount** — the channel comes from configuration, so posting to several channels needs one row per channel; the model cannot choose a destination that configuration did not name.
- **Delivery is best-effort at call time** — a send that exhausts its retries fails the tool call and is not queued for later; nothing redelivers it if Discord stays down.
- **No inbound messages** — reading Discord requires `@deepseek-ai/dsh-discord-gateway`; this package only writes.
- **Chunking splits at word boundaries** — a body longer than 2000 characters becomes several messages, and Discord renders them as separate posts rather than one embed or thread.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`DISCORD_MAX_CONTENT_CHARS`, `chunkContent`, `postChannelMessage`, `openDirectMessageChannel`, `sendDiscordMessage`, and `defangBroadcastMentions` are exported so the gateway and tests reuse one delivery path. The transport is a constructor parameter, which is how tests assert request bodies and rate-limit handling without a network.

</details>

**Runtime invariant:** No companion is published. The package registers a tool through its own fiber and holds no process-global state; each mount's registration is covered by its owning tests.
