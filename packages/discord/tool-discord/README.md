---
description: "Model-facing Discord delivery over the raw REST API: one channel-bound send tool with chunking, rate-limit waits, and broadcast-mention rewriting, for users wiring agent output into a Discord channel."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-discord

English | [中文](README.zh.md)

## Summary

The `discord_send` tool posts to a configured Discord channel or an allowlisted user's direct messages. It uses the REST API, resolves its bot token from a credential reference, splits bodies above 2000 UTF-16 units, waits through bounded rate limits, neutralizes broadcast mentions, and disables all other mentions. Replies preserve native Markdown; tables become labeled bullet groups, and split fenced code blocks retain their language, indentation, and newlines. Mount it beside a credential provider.

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
- **Long answers use several posts** — prose splits at paragraph, line, or word boundaries; oversized code lines can split within a word. The configured chunk cap rejects an oversized answer before any part is posted.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The gateway reuses the package's Markdown formatter, chunker, and REST transport. Typed message bodies support embeds, buttons, and string selectors; message posts and edits always disable mentions. The shared request helper accepts bot-authenticated and interaction-token endpoints, refuses redirects, bounds responses to 2 MiB, and omits credential-bearing URLs and causes from transport errors. `postDiscordMessageBody` applies the sender’s bounded rate-limit retries and per-attempt timeout to an already-formatted message and returns the accepted response. Other REST callers own response-status handling and retry timing.

</details>

**Runtime invariant:** No companion is published. The package registers a tool through its own fiber and holds no process-global state; each mount's registration is covered by its owning tests.
