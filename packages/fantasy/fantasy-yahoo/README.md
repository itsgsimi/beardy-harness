---
description: "Yahoo Fantasy v2 read-only provider with a DSH-owned OAuth store and human authorization command."
kind: "package-reference"
---

# @deepseek-ai/dsh-fantasy-yahoo

English | [中文](README.zh.md)

## Summary

Read Yahoo Fantasy data without exposing credentials to a model. The provider imports an existing private cache once into its own store, refreshes that store under a cross-process lock, and offers `/fantasy auth` and `/fantasy status` to human callers.

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

Mount the provider with a private JSON `tokenFile` below `$DSH_HOME`. If the store is absent, set `importFrom` to a private yahoo_oauth JSON file. The provider validates the source at load, copies it on first use, and never writes the source. `redirectUri`, `season`, `callerTeams`, and `authPresets` are required. The personal Beardy patch supplies these account-specific values.

| Config | Meaning |
|---|---|
| `tokenFile`, `importFrom` | DSH-owned 0600 store and optional read-once source |
| `redirectUri`, `season` | OAuth callback and NFL season |
| `callerTeams`, `authPresets` | Preset-to-team map and presets allowed to authorize |
| `cacheTtlMs`, `cacheMaxEntries` | Bounded response cache |
| `retryCount`, `retryDelayMs`, `requestTimeoutMs` | API backoff and deadline |
| `lockWaitMs`, `lockStaleMs` | Store lock wait and stale bounds |

`/fantasy auth` returns the Yahoo read-only authorization URL. A second `/fantasy auth <callback URL or code>` exchanges the code and replaces the DSH store. The command records no callback input in the Session log. `/fantasy status` reports token age, last refresh, API reachability, league count, and configured team keys without credential material.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Yahoo JSON uses `fantasy_content`, numbered collections, and arrays of partial entity objects. The parser merges the entity fragments and projects only decision fields. The provider uses GET for Fantasy API reads; the fixed OAuth token endpoint receives authorization-code and refresh exchanges. It re-reads the store inside an exclusive sibling lock, writes a 0600 temporary file, and renames it over the store. The response cache holds derived API responses and has a TTL and entry cap. No invariant companion is published because the token file is the sole authority; the cache is derived and bounded.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Fantasy subsystem](../../../docs/subsystems/fantasy.md) — service operations and team resolution.
- [Model tool](../tool-fantasy/README.md) — bounded result pages.

-----

<a id="model-experience"></a>
## Model Experience

### Yahoo provider

#### What the model sees

The provider registers no model schema or prompt. A separate `fantasy` consumer projects read results into the Session; `/fantasy auth` and `/fantasy status` are human commands.

#### Token effect

The provider adds no model tokens by itself. OAuth values stay outside model results.

#### KV Cache effect

The provider does not alter model request caching. Its Yahoo response cache is separate.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The imported Python cache is a bootstrap source, not a shared refresh store.
- Yahoo fields absent from a response, including some player projections and news, remain absent from the normalized view.
- Live Yahoo behavior requires a read-only smoke by the account owner; fixture tests do not contact Yahoo.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
