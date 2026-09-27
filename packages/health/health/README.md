---
description: "Explicit HTTP endpoint probes with threshold alerts and read-only Host status."
kind: "package-reference"
---

# @deepseek-ai/dsh-health

English | [中文](README.zh.md)

## Summary

Configure named HTTP endpoints in `probes` to observe reachability. An empty list makes no claim about model availability. The plugin keeps state in memory, announces down and recovered transitions through the Discord gateway's durable outbox when `noticeChannelId` is configured, and exposes current probe state and the latest observed cron failure to `/status`. It does not call a model, restart a provider, or keep an incident database.

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

Mount the plugin in a Host composition. The tested empty configuration makes no network request:

```yaml
- name: '@deepseek-ai/dsh-health'
  config:
    probes: []
```

| Field | Default | Meaning |
|---|---|---|
| `probes` | `[]` | Unique `{name, url, credentialRef?, expectedStatus?}` targets; `GET` is fixed, status defaults to 200 |
| `intervalMs` | `60000` | Wait between completed polls |
| `timeoutMs` | `3000` | Deadline for each HTTP request |
| `failureThreshold` | `3` | Consecutive failed observations before down |
| `recoveryThreshold` | `1` | Consecutive successful observations before healthy |
| `noticeChannelId` | absent | Discord channel for transition notices; absence keeps status only |
| `noticeCooldownMs` | `900000` | Suppress repeated notices of the same transition kind during flapping |

Probe URLs must be explicit HTTP(S) addresses without embedded user information or fragments. `credentialRef` resolves through the credentials provider and supplies a bearer token; a missing credential or unexpected HTTP status counts as a failed observation. See the generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-health) for the field schema.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The monitor checks configured probes in one serial poll. Failure and recovery counters change each probe's process-local state at the configured thresholds. Initial success becomes healthy without a notice. A transition carries a stable identity into the gateway's durable outbox; failed acceptance is retried with the same identity while later probes continue. Pending transitions are submitted in order when the gateway accepts them. The cooldown applies separately to down and recovered notices. A URL whose [local backend](../local-model-control/README.md) is intentionally unloaded appears paused with operator and time; the monitor skips its request and down notice. The health owner observes failed cron outcomes for `/status` without posting a second notice.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Validation, polling, status snapshot, and transition handoff |
| [gateway](../../discord/discord-gateway/README.md) | Durable outbox acceptance and human `/status` reply |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Endpoint health reference](../../../docs/subsystems/health.md) — state and Host API.
- [Cron package](../../cron/cron/README.md) — durable per-job outcome history and `/cron status`.
- [Beardy bundle](../../bundle/beardy/README.md) — empty probe mount and deployment configuration.

-----

<a id="model-experience"></a>
## Model Experience

None, as this Host plugin only polls configured endpoints and supplies human command status; it adds no model input or tool.

#### KV Cache effect

None; probes and outbox notices do not change model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **HTTP reachability is not generation health.** A successful endpoint status does not prove that a provider can answer a model request.
- **Probe state resets on restart.** The next poll starts from `unknown`; the plugin stores no incident history. Discord's outbox keeps accepted notices through delivery retries.
- **Cron facts are process-local.** `/status` shows the last failed run observed while this Host is mounted; `/cron status` reads the scheduler's durable per-job history.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No runtime invariant companion is published: each probe has one in-memory state owner, and outbox acceptance is owned by the Discord gateway.

</details>
