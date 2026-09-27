---
description: "Let authorized human presets load or unload fixed local model backends and inspect durable intentional-unload state."
kind: "package-reference"
---

# @deepseek-ai/dsh-local-model-control

English | [中文](README.zh.md)

## Summary

Use `/models` to inspect, load, or unload configured Docker containers and remote halorun profiles. Named group commands such as `/gaming on` unload only their configured members; `off` loads them. Successful unload intent survives Host restarts and pauses matching health probes, blocks provider routes before admission, and records matching cron fires as skipped. Commands are available only to configured Agent presets and never enter a model tool catalog.

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

Mount this Host plugin with explicit state storage, operator identity, authorized presets, and backends:

```yaml
- name: '@deepseek-ai/dsh-local-model-control'
  config:
    stateFile: /var/lib/dsh/local-model-control.json
    operatorName: Operator
    allowedPresets: [operator]
    backends:
      - name: local
        kind: docker
        container: local-model
        routes: [local-provider]
        healthUrl: http://127.0.0.1:8000/v1/models
        loadTimeoutMs: 300000
    groups:
      gaming: [local]
```

| Field | Default | Meaning |
|---|---|---|
| `stateFile` | required | Absolute path for durable intent; parent directories are created on the first successful action |
| `operatorName` | required | Human name shown with unload time in status |
| `allowedPresets` | required | Agent preset IDs allowed to invoke every control command |
| `backends` | required | Distinct backend names, fixed Docker container or halorun profile and SSH target, distinct provider routes, optional health URL, and load timeout |
| `backends[].holdFile` | absent | Optional remote watchdog pause file for a halorun backend; use a safe absolute path or `~/` path |
| `groups` | `{}` | Command names mapped to nonempty lists of configured backends |
| `commandTimeoutMs` | `30000` | Deadline for each control process |
| `healthPollMs` | `1000` | Wait between load health checks |
| `graceMs` | `1000` | Subprocess termination grace |

`/models status` reports intent for every backend. `/models unload <name>` stops the configured target, then persists who and when. For a halorun backend with `holdFile`, unload creates the remote parent directory and pause file before stopping; load removes the file before starting. A failed hold step stops the action before halorun runs. `/models load <name>` waits for HTTP 200 from its health URL when configured, then clears intent. A failed load leaves intent unchanged. Group commands act in configured order; a failed member stops the sequence and reports earlier successes. [The configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-local-model-control) describes the loader schema.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host service publishes the current intentional-unload map to health, pi-ai route admission, and cron. Mutating commands are serialized within one Host and replace the state file atomically. The subprocess request specifies argv, cwd, bounded output, deadline, cancellation, and termination grace; deployment strings are validated as safe tokens before mount. Remote hold paths use absolute or `~/` spelling with safe path segments; separate checked SSH argv calls create or remove the file. Health matches an exact configured URL, and cron checks the job's chosen provider before reserving a Session.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Validation, persistence, process control, commands, and read-only status |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Health plugin](../health/README.md) — paused probes and human `/status`.
- [Cron plugin](../../cron/cron/README.md) — durable skipped-fire history.
- [pi-ai adapter](../../llm/llm-pi-ai/README.md) — route admission.

-----

<a id="model-experience"></a>
## Model Experience

None, as human control commands add no model-facing tool or prompt.

#### KV Cache effect

None; the controller adds no tokens to model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Status records intent, not independent process state.** Use a health probe to observe reachability after load; the controller does not poll container or remote process listings for `/models status`.
- **One Host owns mutations.** The in-process queue serializes commands in one gateway; separate gateways sharing a state file require an external single-owner deployment rule.
- **A failed state write reports an error.** After a successful unload, this Host keeps the backend paused in memory; repair storage before restart to preserve that intent.
- **Remote control uses SSH's command transport.** Targets and remote command tokens are fixed by validated configuration; the controller never accepts command text as argv.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The read-only service is a Host extension point for consumers that need to avoid intentionally unloaded routes. No runtime invariant companion is published: one controller owns the map and each read derives directly from it.

</details>
