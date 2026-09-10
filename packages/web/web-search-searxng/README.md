---
description: "The SearXNG-backed search provider for ctx.web: how deployments use a self-hosted metasearch instance without a vendor API key."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-searxng

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-searxng`, the harness searches through a SearXNG instance without a vendor API key and keeps the model-facing `web_search` contract unchanged. Choose it when a deployment controls a SearXNG service or has access to a trusted instance that exposes the JSON search format. SearXNG returns source records rather than a generated answer, so results carry citeable URLs, titles, snippets, and optional publication dates but no `content`.

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

Mount the provider in a composition that already loads the web service; it registers as the `searxng` search provider, so `ctx.web.search()` resolves it automatically when it is the only usable search backend — or pin it with `searchProvider: searxng`.

### When to choose it

Choose this backend when a deployment wants self-hosted or independently operated search without `DEEPSEEK_API_KEY`, `EXA_API_KEY`, or another vendor credential. The provider is unavailable when its endpoint is absent or is not an absolute HTTP(S) URL; a connection failure remains an explicit `WEB_PROVIDER_ERROR` at search time.

### Minimal configuration

Load the web service and the provider; the endpoint falls back to `$SEARXNG_BASE_URL` from the launch environment. The provider does not send an API key or authorization header.

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-searxng'
  config:
    baseURL: !!js process.env.SEARXNG_BASE_URL
```

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | `$SEARXNG_BASE_URL` | SearXNG instance base URL; `/search?format=json` is requested. An absent, credential-bearing, stateful, or non-HTTP(S) value makes the provider unavailable |

The SearXNG instance must enable the JSON response format in `settings.yml`, for example by including `json` beside `html` under `search.formats`; the [SearXNG Search API](https://docs.searxng.org/dev/search_api.html) documents this requirement and endpoint parameters. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-searxng) is the exhaustive source for every accepted field and its JSDoc.

### What a search returns

Each SearXNG result maps to a `WebSearchSource`: `url` is required, `title` maps to `title`, `content` maps to `snippet`, and `publishedDate` maps to `publishedAt`. Blank optional fields are omitted, blank URLs are dropped, and SearXNG's result records do not create provider-generated `content`. The shared web service enforces the request's `maxResults` bound after the provider returns.

### Failures and recovery

Provider failures — HTTP errors, network failures, unparseable JSON, or wrong-shaped result fields — surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`. Callers route on the code; the model-facing `web_search` tool surfaces failures to the model under its own error wrapper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the adapter's observable design; the package contract is fully covered in [Use this package](#use-this-package).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, environment fallback, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `SearxngSearchProvider`: request dispatch, JSON validation, abort classification, and result mapping |
| [`src/types.ts`](src/types.ts) | SearXNG wire types: `SearxngSearchResponse`, `SearxngResult`, and `SearxngError` |

### Request and mapping flow

`search()` sends one encoded query to `{baseURL}/search` with `format=json`, `redirect: 'error'`, and an `Accept: application/json` header. The adapter validates the response envelope and consumed fields, maps source metadata, and leaves final result truncation to `ctx.web`. It sends no credential, so the SearXNG deployment owns any access control outside this provider.

</details>

**Runtime invariant:** No companion is published because the provider contributes no independent event sequence or mutable data relationship beyond behavior enforced by the Web service.

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared vocabulary to the service, the model-facing tools, and the SearXNG API.

- [Web subsystem](../../../docs/subsystems/web.md) — the exhaustive search request/result vocabulary and error codes.
- [Web package map](../README.md) — the seven-package family and each role.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_search` tool that renders this provider's sources.
- [SearXNG Search API](https://docs.searxng.org/dev/search_api.html) — the upstream JSON endpoint and response parameters.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-searxng) — every accepted config field and its source declaration.
- [Web capability seam decision](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) — why search and fetch share one provider-selection service.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-web`, which retains this provider's `maxResults`-bounded URLs, titles, snippets, and publication dates or its exact `SearXNG search aborted`, `SearXNG search request failed: <error>`, and `SearXNG returned an unprocessable response body: <error>` failures under the consumer's error wrapper.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the provider is a poor fit. They are current package constraints.

- **The SearXNG JSON format must be enabled by the instance operator** — instances that expose only HTML return an HTTP error, commonly `403`.
- **No provider-generated answer is returned** — SearXNG supplies source records, so `web_search` receives no `content` field from this backend.
- **SearXNG controls its own upstream engines and result ordering** — the adapter exposes only the provider-neutral query and result bound; engine selection and ranking remain instance configuration.
- **The provider does not authenticate requests** — use a trusted local or access-controlled SearXNG endpoint rather than placing credentials in the base URL.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and the linked Agent Note.

None.

</details>
