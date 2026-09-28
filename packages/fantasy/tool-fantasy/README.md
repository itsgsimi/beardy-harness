---
description: "Bounded model-facing Yahoo Fantasy reads with caller-owned team resolution."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-fantasy

English | [中文](README.zh.md)

## Summary

Ask for current Fantasy facts through one read-only `fantasy` tool. It returns leagues, settings, standings, projected matchups, rosters, player search and availability, transactions, draft picks, and weeks in bounded pages.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount a Fantasy provider and the tool registry. Set optional `pageChars` to a value from 100 through 32000; the default is 8000. Use `team` without a key for the caller's configured team. Player reads require a search term or availability filter; player and transaction provider pages use `start` and `count` (at most 25). Player results report `sort_scope`: `none` when no sort was requested, `league` for Yahoo points or rank sorting, and `page` for percent owned.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The tool takes a live caller Session and obtains its team from the provider's validated preset mapping. Model arguments may select another explicit league, team, or player key but cannot choose a caller identity. The consumer serializes normalized views and slices the JSON by Unicode characters; `next_offset` and `total_chars` make long responses resumable. Every tool result enters normal Session tool history. No invariant companion is published because the tool owns no state beyond its registration.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Fantasy provider](../fantasy-yahoo/README.md) — account token and API behavior.
- [Fantasy subsystem](../../../docs/subsystems/fantasy.md) — read views and ownership.

-----

<a id="model-experience"></a>
## Model Experience

### Fantasy tool

#### What the model sees

One `fantasy` schema offers eleven read actions; its description says that a roster player with `slotLocked: true` cannot change lineup slots this week. Results contain normalized JSON in `text`, with `next_offset` for response slices and `next_start` for Yahoo player or transaction pages. Tool calls and results enter the caller Session.

#### Token effect

Each result carries at most `pageChars` data characters plus a small paging wrapper. The default data bound is 8000 characters.

#### KV Cache effect

The schema stays stable for a fixed composition; each returned page extends the caller's tool history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The tool cannot submit lineup changes, waiver claims, trades, or any Yahoo write.
- Injury news is not synthesized from unrelated feeds; use dated news separately.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
