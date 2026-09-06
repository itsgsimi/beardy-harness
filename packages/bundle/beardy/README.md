---
description: "The Beardy agent profile bundle: a persistent, history-aware Web agent with curated memory, durable session search, SearXNG search, research fetching, and token-gated Discord delivery."
kind: "package-bundle"
---

# @deepseek-ai/dsh-beardy

English | [中文](README.zh.md)

## Summary

The Beardy bundle adds a persistent, history-aware agent profile over `dsh-base` and `dsh-web-app`. The shipped `beardy` profile includes it automatically and stores a dedicated session-search index under the Harness home. Beardy inherits the complete Creator mode capability roster, including the standard coding tools and live Cordis authoring tools, then adds its identity, `$DSH_HOME/SOUL.md` personality file, curated cross-session memory (`$DSH_HOME/USER.md` and `MEMORY.md` behind one `memory` tool), session search, a conversation clock, SearXNG-backed Web search, and Web fetching. Scheduled runs and Discord delivery come from `dsh-cron`, `dsh-tool-discord`, and `dsh-discord-gateway`; the patch gates those three rows behind a `DISCORD_BOT_TOKEN` credential and ships no cron jobs. Your own briefs, channel destination, gateway workspace, and permission preset come from your profile patch (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`); an enabled row without that configuration fails its schema check loudly rather than running on defaults.

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

### Deploy as an always-on Discord agent

The bundle mounts its three Discord-capable rows only when `DISCORD_BOT_TOKEN` is present in the process environment, and it deliberately carries no destination or authority values. A deployment supplies them from one environment file and one profile patch layer.

Put the non-secret references and identifiers in an environment file (mode `0600`, never in the repository):

```sh
DISCORD_BOT_TOKEN=...
DISCORD_CHANNEL_ID=<channel snowflake that discord_send targets>
DISCORD_DM_USER_IDS=<user ids allowed as direct-message targets>
DISCORD_ALLOWED_USER_IDS=<user ids whose inbound messages the gateway answers>
SEARXNG_BASE_URL=http://127.0.0.1:8080
```

Then add the deployment rows to `$DSH_HOME/profiles/beardy/cordis.patch.yml`. A `- id:` row replaces that row's whole configuration, so restate every field you keep:

```yaml
- id: tool-discord
  config:
    tokenEnv: DISCORD_BOT_TOKEN
    channelId: !!js process.env.DISCORD_CHANNEL_ID
    dmUserIds: !!js (process.env.DISCORD_DM_USER_IDS || '').split(' ').filter(Boolean)

- id: discord-gateway
  config:
    tokenEnv: DISCORD_BOT_TOKEN
    allowedUserIds: !!js (process.env.DISCORD_ALLOWED_USER_IDS || '').split(' ').filter(Boolean)
    workspacePath: /srv/beardy-workspace
    agentPreset: beardy-discord
    permissionPreset: danger-full-access

- id: cron
  config:
    jobs:
      - name: morning-brief
        expression: '0 7 * * *'
        timezone: Europe/Zagreb
        agentPreset: beardy-unattended
        permissionPreset: workspace-write
        prompt: Prepare the morning brief and send it with discord_send.
```

Run it under systemd so it survives logout and reboots:

```ini
[Unit]
Description=Beardy persistent agent (dsh web)
After=network-online.target

[Service]
WorkingDirectory=/srv/deepseek-harness
EnvironmentFile=/etc/beardy/environment
ExecStart=/usr/bin/env pnpm dsh --profile beardy
Restart=always

[Install]
WantedBy=multi-user.target
```

The three shipped Beardy presets split the roles: sessions you start in the Web use `beardy`, gateway conversations run `beardy-discord` (short plain-text replies, memory writes staged for approval), and cron jobs run `beardy-unattended` (delivers with `discord_send`, authoring tools off). An enabled row whose profile configuration is missing fails at load naming the required field, so a half-configured deployment never runs on someone else's defaults.

### Add the bundle to another profile

Install the bundle into a custom profile when another application surface needs the Beardy defaults:

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-beardy
```

The bundle contributes a patch layer; it is not a library or an application bin. Later profile, home, and `--patch` layers replace its rows by id, and a row replacement must restate the complete configuration it keeps.

### What you get

- The Beardy persona identifies the agent as a warmly pragmatic coding and research agent.
- `$DSH_HOME/SOUL.md` supplies Beardy's editable personality without replacing project `AGENTS.md` or `CLAUDE.md` instructions.
- Curated cross-session memory: the `memory` tool edits `$DSH_HOME/USER.md` and `MEMORY.md`, and both files load back into later sessions as user-global instructions.
- A conversation clock (`dsh-time-context`) resolves relative time for conversations that span days, with durable injections throttled to hourly.
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

The patch selects the shipped `beardy` agent preset, overrides `session-query-sqlite`, selects the `searxng` web provider, disables the DeepSeek search row, enables `tool-web`, and inserts `tool-session-query`, `time-context`, and the token-gated `tool-discord`, `discord-gateway`, and `cron` rows. The Beardy preset uses the read-only `agent-presets` include row to layer its identity, the curated memory files as global instruction candidates, and the `memory` tool over Creator mode; `beardy-unattended` and `beardy-discord` derive from it with their own persona addenda and stricter `memory` approval. SearXNG owns Web search transport and result mapping, the search backend owns a separate derived SQLite database, and the history-tool consumer owns model-facing schemas, guidance, and workspace authorization. The bundle itself owns no runtime service or mutable state.

### Source map

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Beardy's patch layer over the base and Web bundles |
| [`src/index.ts`](src/index.ts) | Package entry; carries no runtime API |
| [`src/invariant.ts`](src/invariant.ts) | Empty invariant companion for the static patch carrier |
| [`tests/beardy.spec.ts`](tests/beardy.spec.ts) | Manifest, patch, dependency, and default checks |
| [`tests/composition.spec.ts`](tests/composition.spec.ts) | Token gating, no-deployment-data, and required-field failure checks |

### Invariant ownership

The bundle registers no runtime invariant because it only replaces and inserts rows owned by other packages. Each runtime package checks its own services, events, and persistence relationships.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Bundle package map](../README.md) — the profile layers shipped with DSH.
- [app-boot profile contract](../../boot/app-boot/README.md) — profile initialization and patch precedence.
- [Memory tool package](../../memory/tool-memory/README.md) — the curated `USER.md` / `MEMORY.md` editor.
- [Session query package](../../session-query/tool-session-query/README.md) — the history tools Beardy exposes to the model.
- [SQLite search backend](../../session-query/session-query-sqlite/README.md) — the durable derived index.
- [Generated composition graph](../../../apps/cli/composition.md) — the exact rows in each shipped profile.

-----

<a id="model-experience"></a>
## Model Experience

### Beardy system prompt

#### What the model sees

The profile contributes one stable persona before the base prompt sections and selected tools. The runtime resolves `{{model}}` and `{{cwd}}` for the current process. The `beardy-unattended` and `beardy-discord` presets append one stable sentence each: unattended runs learn they must decide alone and deliver through `discord_send`; Discord replies are told to stay short and plain-text.

##### Persona text

```markdown
You are Beardy, a warmly pragmatic coding and research agent powered by the {{model}} model. Your working directory is {{cwd}}.
When the user refers to a past conversation, use session_search before asking them to repeat it.
```

#### Token effect

One short stable persona plus the data-dependent base prompt sections and selected tool schemas.

#### KV Cache effect

Stable for a fixed profile, provider, model, and tool roster. The persona changes only when the profile composition or model context changes.

### Harness authoring

#### What the model sees

Beardy also receives Creator mode's Cordis inspection and temporary-package tools, plus the `editing-cordis-compositions` skill. Shell and filesystem tools remain the path for durable source or user-preset edits; dynamic Cordis packages disappear when stopped or when DSH restarts. The `beardy-unattended` preset disables both authoring surfaces.

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

### Curated memory and clock

#### What the model sees

The `memory` tool schema with its two fixed targets (`user`, `memory`) and three actions, plus the current contents of `$DSH_HOME/USER.md` and `MEMORY.md` loaded as user-global instructions. The clock contributes a stable time-context section that re-renders at most hourly per session.

#### Token effect

One small stable tool schema plus the data-dependent memory files inside the instruction budget; the clock adds one short dated section that changes only when it refreshes.

#### KV Cache effect

Memory file contents sit in the durable instruction prefix and change the prefix only when a write lands. The hourly clock refresh changes one late section, not the whole prefix.

### Session history tools, Web search, and Web fetch

#### What the model sees

The profile adds the five read-only history-tool schemas and guidance from [`dsh-tool-session-query`](../../session-query/tool-session-query/README.md), including the generated [`session_search`, `session_event_search`, `session_trace`, `session_event_trace`, and `session_event_read` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-session-query). The existing Web tool searches through the configured SearXNG endpoint and fetches through the anonymous HTTP provider; the owning packages provide its exact schema and result text.

#### Token effect

Five stable history-tool schemas and one concise guidance section are present while the bundle is mounted. Search, trace, event, and fetch results are data-dependent additions to the logged conversation.

#### KV Cache effect

The history guidance and tool schemas remain prefix-stable for a fixed bundle and configuration. Search and fetch results append after that reusable prefix.


## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No automatic skill curator** — skills are discovered and loaded through the base skill packages; Beardy does not write or improve skills automatically.
- **Scheduled jobs are configuration-only** — jobs run from the `dsh-cron` config in your profile patch, and nothing creates or edits a job at runtime; changing the timetable, feeds, or destination means editing a patch and restarting.
- **One process per bot token** — the gateway answers every inbound direct message it sees, so running this profile alongside another that mounts `dsh-discord-gateway` with the same token replies twice.
- **No general messaging gateway** — the profile provides the Web application; Discord is its only channel adapter, and there is none for Telegram, Slack, or similar services.
- **Memory writes in unattended sessions refuse** — `beardy-unattended` and `beardy-discord` raise `requireApproval`, and a session with no approval answerer receives a refusal instead of a silent write; durable answer routing over Discord is deferred.
- **Search uses a separate database** — do not point `session-query-sqlite.path` at the session-persistence database.
- **SearXNG is an external prerequisite** — the default local endpoint must be running and must expose the JSON response format before Beardy can use `web_search`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
