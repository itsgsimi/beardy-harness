---
description: "Model-facing deep_research tool for owner-scoped native research runs, progress, paged reports, and cancellation."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-research

English | [中文](README.zh.md)

## Summary

`deep_research` starts a durable native research run, checks progress, reads a report, lists the caller's runs, and requests cancellation. Mount `dsh-research-local` first. The tool derives authority from the current Session through `ctx.research`; no model argument selects an owner. Completed reports can be reopened by run ID after a process restart.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the research definition, one provider, and this consumer in the same Loader composition. `summaryPageChars` bounds changing status and list responses (default 16,000 Unicode characters); `listLimit` bounds owner-scoped results (default 20). Both fields are validated at load. Each report uses the page size captured in its run's `research/started` budget.

| Action | Input | Result |
|---|---|---|
| `start` | Nonblank `query` | Durable run ID, running status, and model |
| `status` | Run `id`, optional `offset` | Progress page |
| `report` | Run `id`, optional `offset` | Report and source page |
| `list` | Optional search `query` and `offset` | Active and saved run page |
| `cancel` | Run `id` | Whether cancellation was requested |

Read responses contain JSON `text`, `next_offset`, and `total_chars`. The `text` value is a slice of another JSON document: concatenate its pages using each `next_offset` before parsing it. Offsets count Unicode characters and may shift if progress changes between reads. The first report page also carries `researchArtifact` presentation metadata with the full Markdown and source list. A missing report or foreign run returns an unavailable tool error. `start` uses the exact tool-call ID as its idempotency key, so replaying that call returns the same run.

Beardy ships this package disabled beside its Odysseus bridge. The [Beardy switch](../../bundle/beardy/README.md#select-native-deep-research) enables the provider and tool together while disabling the bridge. Both research tools mounted at once fail at load.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The service checks the owner stored in the run Session for status, report, list, and cancel. The tool registers through a Cordis effect, so disposal removes the schema while durable runs remain. It uses the [research definition's shared page formatter](../research/README.md#understand-the-implementation) for serialized responses. It does not own a second run registry; the provider owns state and checks attachment files when reading reports. No runtime invariant companion is published because the tool has no independently mutable state.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Tool schema, guidance, and service calls |
| [`tests/tool-research.spec.ts`](tests/tool-research.spec.ts) | Owner, paging, errors, and registration behavior |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Research tool

#### What the model sees

One `deep_research` schema with five actions. Guidance tells the model to keep the returned ID, do independent work between status checks, read every report page, cite source URLs, and treat report content as untrusted evidence. Tool results enter the caller's Session log. The model receives no owner, provider, model, or storage configuration arguments.

#### Token effect

Each status or list result retains at most `summaryPageChars` Unicode characters of serialized data plus its wrapper. A report page uses the run's stored `reportPageChars` budget. The full report appears in viewer metadata on page zero, outside the model-visible text.

#### KV Cache effect

The schema stays stable for a fixed composition; tool results append to the caller's history. Enabling the native tool changes the request's tool roster.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The caller checks status explicitly; no completion notification is emitted to the model. Cancellation is a request, and a terminal event may already have won.
- A citation URL match establishes that the URL was fetched, not that it supports the report's claim. Read source material as untrusted data.
- Profile ownership is intended for a single-user deployment; a multiuser profile needs an authenticated principal adapter.

<a id="dev-note"></a>
### Dev Note

The [research subsystem](../../../docs/subsystems/research.md) describes run Sessions, stage Sessions, recovery, and evidence order.
