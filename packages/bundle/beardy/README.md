---
description: "The Beardy agent profile bundle: a persistent, history-aware Web agent with durable session search, SearXNG search, and research fetching."
kind: "package-bundle"
---

# @deepseek-ai/dsh-beardy

English | [中文](README.zh.md)

## Summary

The Beardy bundle adds a persistent, history-aware agent profile over `dsh-base` and `dsh-web-app`. The shipped `beardy` profile includes it automatically and stores a dedicated session-search index under the Harness home. Beardy inherits the complete Creator mode capability roster, including the standard coding tools and live Cordis authoring tools, then adds its identity, `$DSH_HOME/SOUL.md` personality file, session search, SearXNG-backed Web search, and Web fetching. It can search prior sessions and the Web without a DeepSeek search credential, inspect events and lineage, fetch Web pages, modify accessible harness source and presets, and temporarily extend the running process. The bundle does not provide persistent personal memory, automatic skill curation, cross-session scheduling, or messaging adapters.

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

### Run the shipped Beardy profile

The installation auto-initializes the `beardy` profile from the base, Web, and Beardy bundle layers:

```sh
dsh --profile beardy --dump-default-config
dsh --profile beardy
```

The profile uses live patch reload, stores the dedicated derived search index at `$DSH_HOME/session-search.sqlite`, and opens SQLite when the first search runs. The profile's own and home-level patch files can replace these rows with the normal profile-layer rules.

Beardy sends `web_search` to the SearXNG JSON endpoint at `http://127.0.0.1:8080` by default. Set `SEARXNG_BASE_URL` before launch to use another instance, and enable the `json` format in that instance's `search.formats` configuration. See the [SearXNG provider README](../../web/web-search-searxng/README.md) and [SearXNG Search API](https://docs.searxng.org/dev/search_api.html) for the endpoint contract.

### Add the bundle to another profile

Install the bundle into a custom profile when another application surface needs the Beardy defaults:

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-beardy
```

The bundle contributes a patch layer; it is not a library or an application bin. Later profile, home, and `--patch` layers replace its rows by id, and a row replacement must restate the complete configuration it keeps.

### What you get

- The Beardy persona identifies the agent as a warmly pragmatic coding and research agent.
- `$DSH_HOME/SOUL.md` supplies Beardy's editable personality without replacing project `AGENTS.md` or `CLAUDE.md` instructions.
- The complete Creator mode capability roster remains available and is inherited rather than duplicated.
- Creator mode's Cordis inspection, temporary package, and composition-authoring capabilities are available to Beardy.
- Durable SQLite full-text search covers persisted session history without using the session-persistence database.
- Five workspace-authorized session-history tools let the model search, trace, and read prior work.
- SearXNG-backed Web search and Web fetching are enabled without a DeepSeek search credential.
- Existing DSH safety, skill, goal, workflow, subagent, shell, filesystem, and approval behavior remains composed from their owning packages.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The patch selects the shipped `beardy` agent preset, overrides `session-query-sqlite`, selects the `searxng` web provider, disables the DeepSeek search row, enables `tool-web`, and inserts `tool-session-query`. The Beardy preset uses the read-only `agent-presets` include row to layer its identity and global `SOUL.md` candidate over Creator mode; Creator mode in turn inherits the standard roster and adds the self-modification tools and skill. SearXNG owns Web search transport and result mapping, the search backend owns a separate derived SQLite database, and the history-tool consumer owns model-facing schemas, guidance, and workspace authorization. The bundle itself owns no runtime service or mutable state.

### Source map

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Beardy's patch layer over the base and Web bundles |
| [`src/index.ts`](src/index.ts) | Package entry; carries no runtime API |
| [`src/invariant.ts`](src/invariant.ts) | Empty invariant companion for the static patch carrier |
| [`tests/beardy.spec.ts`](tests/beardy.spec.ts) | Manifest, patch, dependency, and default checks |

### Invariant ownership

The bundle registers no runtime invariant because it only replaces and inserts rows owned by other packages. Each runtime package checks its own services, events, and persistence relationships.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Bundle package map](../README.md) — the profile layers shipped with DSH.
- [app-boot profile contract](../../boot/app-boot/README.md) — profile initialization and patch precedence.
- [Session query package](../../session-query/tool-session-query/README.md) — the history tools Beardy exposes to the model.
- [SQLite search backend](../../session-query/session-query-sqlite/README.md) — the durable derived index.
- [Generated composition graph](../../../apps/cli/composition.md) — the exact rows in each shipped profile.

-----

<a id="model-experience"></a>
## Model Experience

### Beardy system prompt

#### What the model sees

The profile contributes one stable persona before the base prompt sections and selected tools. The runtime resolves `{{model}}` and `{{cwd}}` for the current process.

##### Persona text

```markdown
You are Beardy, a warmly pragmatic coding and research agent powered by the {{model}} model. Your working directory is {{cwd}}.
```

#### Token effect

One short stable persona plus the data-dependent base prompt sections and selected tool schemas.

#### KV Cache effect

Stable for a fixed profile, provider, model, and tool roster. The persona changes only when the profile composition or model context changes.

### Harness authoring

#### What the model sees

Beardy also receives Creator mode's Cordis inspection and temporary-package tools, plus the `editing-cordis-compositions` skill. Shell and filesystem tools remain the path for durable source or user-preset edits; dynamic Cordis packages disappear when stopped or when DSH restarts.

#### Token effect

The creator tools add stable schemas and guidance to the model context. Runtime package code and its registrations add data-dependent content only while that package runs.

#### KV Cache effect

The creator tool schemas and guidance remain stable for a fixed profile. Starting or stopping a dynamic package changes the later request prefix when that package contributes tools or prompt sections.

### SOUL.md personality

#### What the model sees

Beardy loads `$DSH_HOME/SOUL.md` as a durable global instruction alongside `$DSH_HOME/AGENTS.md`. The file contains tone, initiative, uncertainty, disagreement, continuity, and brevity preferences; it does not grant permissions or replace project instructions.

#### Token effect

The file consumes the normal workspace-instruction budget and remains in durable session history like other instruction files.

#### KV Cache effect

The file is stable for a workspace until its contents change; editing it changes the instruction prefix for later requests.

### Session history tools, Web search, and Web fetch

#### What the model sees

The profile adds the five read-only history-tool schemas and guidance from [`dsh-tool-session-query`](../../session-query/tool-session-query/README.md), including the generated [`session_search`, `session_event_search`, `session_trace`, `session_event_trace`, and `session_event_read` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-session-query). The existing Web tool searches through the configured SearXNG endpoint and fetches through the anonymous HTTP provider; the owning packages provide its exact schema and result text.

#### Token effect

Five stable history-tool schemas and one concise guidance section are present while the bundle is mounted. Search, trace, event, and fetch results are data-dependent additions to the logged conversation.

#### KV Cache effect

The history guidance and tool schemas remain prefix-stable for a fixed bundle and configuration. Search and fetch results append after that reusable prefix.


## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No personal memory store** — Beardy can search session history, but it does not yet maintain a separate curated user or project memory.
- **No automatic skill curator** — skills are discovered and loaded through the base skill packages; Beardy does not write or improve skills automatically.
- **No cross-session scheduler** — the existing session-local schedule remains the only scheduled-reminder behavior.
- **No messaging gateway** — the profile provides the Web application but no Telegram, Discord, Slack, or similar channel adapter.
- **Search uses a separate database** — do not point `session-query-sqlite.path` at the session-persistence database.
- **SearXNG is an external prerequisite** — the default local endpoint must be running and must expose the JSON response format before Beardy can use `web_search`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
