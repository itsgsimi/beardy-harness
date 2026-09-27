---
description: "Local Session-backed research storage for durable run state, owner checks, restart reconciliation, and immutable report attachments."
kind: "package-reference"
---

# @deepseek-ai/dsh-research-local

English | [中文](README.zh.md)

## Summary

Mount this provider to keep research run IDs, progress, and reports across process restarts. It commits a run before acknowledging its caller and lists runs by projecting their persisted Session logs. A restart marks unfinished runs interrupted; no external work starts on recovery. This storage package does not yet run a model or expose a research tool.

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

Mount the provider with the Agent factory, Session store and persistence, and an attachment store that supports verbatim files.

### When to choose it

Choose it for local research runs whose progress must survive a caller ending and whose reports need immutable storage. It does not replace the existing Odysseus HTTP tool while the native engine and consumer are absent.

### Minimal configuration

The Loader composition test mounts this provider with these fields:

```yaml
- name: '@deepseek-ai/dsh-research-local'
  config:
    provider: mock
    model: test-model
```

`provider` and `model` are required exact route labels. `ownerScope` defaults to `session`; `profile` requires a nonblank `ownerNamespace` for an explicitly single-user deployment. `maxReportBytes` defaults to 1048576 and `maxEvidenceBytes` to 8388608; both limit complete attachment bytes. The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-research-local) records the full schema.

### Read and recover

The service flushes `research/started` on a new run Session, then flushes `research/linked` on the caller before acknowledging `start`. The exact caller `requestKey` returns the same run after an ambiguous retry. Owner-scoped `list` reads persisted run Sessions. The first service access after restart changes an unfinished run to `interrupted` without replaying its work. Completion requires both report and evidence attachments; a report read verifies both files and fails if either is missing or changed.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The run Agent is created under the provider's service context and remains idle while the storage layer accepts checkpoints. Its Session log is the authority for phase and owner; the process-local map only holds handles for disposal and live writes. Terminal report files are saved before their referencing event, and `ctx.sessions.flush` is the commit barrier. A failed caller flush may leave a discoverable run Session. A rejected run flush can also have committed through another listener, so retries inspect the durable log.

No runtime invariant companion is published because the run Session is the sole state authority, while attachment availability is checked when a report is read.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Run projection, commit order, owner checks, and recovery |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Research definition](../research/README.md) — service and event types.
- [Research subsystem](../../../docs/subsystems/research.md) — run authority and stage Session relationship.
- [Session-backed research decision](../../../.agents/notes/implemented/feature/2026-09-27-session-backed-research-runs.md) — recovery rationale.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through a future research consumer and logged stage Agents.

#### KV Cache effect

This storage provider adds no prompt or tool schema and starts no model call. It does not change a model request; each future stage Agent will have its own independent request history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- No engine or model-facing tool starts research work. A started run remains open until a storage caller finishes, cancels, or recovery interrupts it.
- Stage Sessions are not yet created. Before the engine creates them, Session lists and `session_search` need a default exclusion for research-stage children, with explicit inspection still available by ID.
- Profile ownership is only valid for an explicitly single-user composition; this provider does not authenticate separate human principals.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
