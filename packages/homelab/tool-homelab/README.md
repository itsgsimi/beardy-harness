---
description: "Read Beardy inventory, network, DNS, disk, Docker, firewall, router, and diagnostic facts through one bounded read-only model tool."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-homelab

English | [中文](README.zh.md)

## Summary

Use `homelab` to inspect selected home-network facts through the Beardy CLI. A deployment chooses the executable, the secrets file, the Docker host IDs, the agent presets that may call it, and the time and output limits. The model names one observation and receives projected rows; command text, flags, and `--yes` are never model inputs.

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

Mount the tool beside `dsh-tools`, Session projections, and a subprocess provider. The Beardy bundle ships its row disabled; a personal patch supplies the paths and allowlists before enabling it.

```yaml
- id: tool-homelab
  name: '@deepseek-ai/dsh-tool-homelab'
  config:
    bdyPath: /home/goran/beardy/bin/bdy
    secretsPath: /home/goran/.config/beardy/secrets.env
    allowedHosts: [mini, pihole]
    allowedAgentPresets: [beardy, beardy-discord]
```

| Field | Default | Meaning |
|---|---|---|
| `bdyPath` | Required | Absolute `bin/bdy` path inside a Beardy checkout that contains `src/cli.ts` and `inventory/hosts.json`. |
| `secretsPath` | Required | Beardy secrets file, passed to Beardy as `BDY_SECRETS_FILE`; its values are redacted from results. |
| `allowedHosts` | Required | Inventory IDs `docker_status` may name; an empty list removes that action. |
| `allowedAgentPresets` | Required | `any`, or the agent presets whose Sessions may call the tool. The current preset comes from the preset registry's Session projection, else the Session header; a Session without one matches only `any`. |
| `timeoutMs` | `30000` | Wall-clock limit for one call, 1000–300000 ms. |
| `bdyTimeoutSeconds` | `10` | Beardy's own per-operation `--timeout`, 1–120 s, shorter than `timeoutMs`. |
| `graceMs` | `1000` | Termination grace period, 1–30000 ms. |
| `maxStdoutBytes` | `262144` | Collected stdout cap, 4096–4194304 bytes. |
| `maxResultBytes` | `16384` | Serialized result cap, 1024–65536 bytes. |
| `maxCellChars` | `256` | Characters kept per cell after redaction, 16–4096. |

Load fails for a path outside a Beardy checkout, a non-executable `bin/bdy`, a host ID absent from the inventory, or an out-of-range limit. The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-homelab) lists accepted fields.

| Action | Beardy command after `bdy --json --timeout <s>` |
|---|---|
| `hosts` | `hosts list --no-probe` |
| `discover` | `discover --no-ping` |
| `dns` | `dns --resolvers` |
| `disk` | `disk` |
| `docker_status` | `docker <host> ps --all --format <five-field JSON template>` |
| `firewall_rules` | `fw rules` |
| `router_leases` | `router leases` |
| `net_top` | `net talkers --window 1h --limit 10` |
| `doctor` | `doctor` |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Unless `allowedAgentPresets` is `any`, the tool checks the caller Session's current agent preset. It then selects one argv from the table and spawns it through the subprocess service from the Beardy checkout. Each command is a Beardy read: none calls `requireApproval()`, and Beardy classifies `docker ps` as a read. The tool parses Beardy's JSON rows, or Docker JSON lines, and keeps each action's documented columns. It redacts values from the secrets file, bearer tokens, credential assignments, and URL credentials, clips cells, and drops trailing rows to fit `maxResultBytes`. A nonzero exit keeps rows Beardy printed first, such as an unreachable host in `disk`. Stderr is discarded, and failures use fixed codes. An unreadable secrets file fails the call closed. No invariant companion is published because the plugin owns no state beyond its registration.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Subprocess service](../../subprocess/subprocess/README.md) — bounded process execution.
- [Beardy bundle](../../bundle/beardy/README.md) — disabled default row.

-----

<a id="model-experience"></a>
## Model Experience

### Home-lab request

#### What the model sees

The model sees one `homelab` tool with a required `action` and, when Docker hosts are configured, a `host` enum for `docker_status`. Results contain `action`, `status` (`ok`, `error`, or `timeout`), projected `rows`, `omittedRows`, and for failures a fixed `code` and optional `exitCode`. Invalid input and callers outside `allowedAgentPresets` fail before a process starts.

#### Token effect

One schema enters each request while mounted. Each call adds one result of at most `maxResultBytes`, or a tool error, to Session history.

#### KV Cache effect

The schema is stable for a mounted profile; each result extends history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Beardy and a Node runtime of at least 23.6 must be installed in the subprocess provider's execution world.
- Stdout larger than `maxStdoutBytes` yields no rows because incomplete JSON cannot be trusted.
- Redaction covers secrets-file values of at least four characters and common credential forms; keep other private data out of inventory labels.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
