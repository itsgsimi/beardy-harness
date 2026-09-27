---
description: "Research service and durable Session event types for plugins that create, inspect, and cancel owner-scoped runs."
kind: "package-reference"
---

# @deepseek-ai/dsh-research

English | [中文](README.zh.md)

## Summary

Use `ctx.research` to start a durable research run, inspect its progress, list runs for one owner, read a retained report, or cancel a run. The service requires a provider such as `research-local`; loading the abstract definition as a plugin fails. Run IDs and report file references remain stable across process restarts.

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

Mount one provider, then pass a live caller Session and a trusted owner to `start`.

### When to choose it

Choose this service when a consumer needs run IDs, owner checks, and reports that remain valid after its caller finishes. The standalone definition has no storage implementation.

### Ownership and operations

An owner is either the caller Session or a configured single-user profile namespace. A model argument cannot choose the owner. `start` durably saves the run before linking its ID to the caller; an exact `requestKey` makes an ambiguous retry return the existing run. `status`, `list`, `report`, and `cancel` use the stored owner. Foreign and missing IDs return the same unavailable error.

The [research subsystem reference](../../../docs/subsystems/research.md) records the event types and current service signatures.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The abstract service declares the owner-scoped operations. `ResearchRunId` is a branded string; its serialized value is also the run Session ID. The run Session records its start, search and source outcomes, normalized findings, checkpoints, and terminal result; the caller Session records `research/linked`. The Session event map makes these types required on read by a harness that understands them. A trusted caller can select a general report category; the local provider refuses `fantasy_football` until its specialized workflow exists.

The native and Odysseus research tools use this package's page formatter and output schema. A page slices serialized JSON by Unicode code point, reports `next_offset` and `total_chars`, and carries the complete report artifact only when its caller supplies one. Both tools validate offsets before paging; an offset beyond the serialized response fails.

No runtime invariant companion is published because this package declares types and an abstract service without owning mutable runtime state.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Service methods and run ID admission |
| [`src/page.ts`](src/page.ts) | Shared JSON paging and tool output schema |
| [`src/types.ts`](src/types.ts) | Owner, view, report, and durable event types |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Local provider](../research-local/README.md) — storage and recovery behavior.
- [Research decision](../../../.agents/notes/implemented/feature/2026-09-27-session-backed-research-runs.md) — durability rationale.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through consumers that choose which run state and report pages reach a model.

#### KV Cache effect

This package adds no prompt or tool schema. The definition changes no model request by itself; a consumer decides whether later context appends or replaces text.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The definition cannot execute or store a run without a provider.
- A profile owner is an authority value supplied by trusted same-process code; a multiuser deployment needs an authenticated principal adapter before sharing a namespace.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
