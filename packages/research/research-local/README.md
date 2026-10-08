---
description: "Local Session-backed research engine with bounded web evidence, logged model stages, owner checks, and durable reports."
kind: "package-reference"
---

# @deepseek-ai/dsh-research-local

English | [中文](README.zh.md)

## Summary

Mount this provider to research a question through configured model and web providers while keeping progress and reports across process restarts. It commits a run before acknowledging its caller, records every model stage in a child Session, and lists runs by projecting persisted logs. A restart marks unfinished runs interrupted without replaying external work.

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

Mount the provider with the Agent factory, Session store and persistence, an attachment store, an exact LLM route, and usable `ctx.web` search and fetch providers.

### When to choose it

Choose it for local research runs whose progress must survive a caller ending and whose evidence and reports need immutable storage. Mount the [model-facing consumer](../tool-research/README.md) separately.

### Minimal configuration

The Loader composition test mounts this provider with these fields:

```yaml
- name: '@deepseek-ai/dsh-research-local'
  config:
    provider: mock
    model: test-model
```

`provider` and `model` are required exact route labels. `ownerScope` defaults to `session`; `profile` requires a nonblank `ownerNamespace` for an explicitly single-user deployment. The default run has up to four rounds, two concurrent searches, three concurrent fetches, one model call, and a 30-minute hard limit. `stageTemperature` (0 through 2, default 0.2) sets the sampling temperature of every stage request. Every numeric budget is validated at load and frozen into the run event. The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-research-local) records every field and bound.

### Read and recover

The service flushes `research/started` on a new run Session, then flushes `research/linked` on the caller before acknowledging `start` and launching the engine. The exact caller `requestKey` returns the same run after an ambiguous retry. Owner-scoped `list` reads persisted run Sessions. The first service access after restart changes an unfinished run to `interrupted` without replaying work. Each search, fetch, extraction, stage ID, and draft is committed before progress is published. Cancellation aborts active and queued operations; a committed draft remains available as a partial report. Completion saves report and evidence attachments before the terminal event, and report reads verify both files.

Run and stage Session headers retain the caller's workspace path when available, allowing explicit workspace-authorized stage reads after disposal.

A `start` request with a `workflow` runs that consumer procedure instead of the general engine. Its run and stage deadlines replace `hardRunTimeoutMs` and `stageTimeoutMs` for that run and are recorded in `research/started`. Its stages share the provider's model admission with general runs, so `maxConcurrentModelCalls` bounds both. A workflow's `stageSystemPrompt` (1 to 4000 characters) replaces the provider's stage system prompt for its stages. A stage's `temperature` option replaces `stageTemperature`, and its `expectJson` check admits one corrective turn: a first answer the check rejects receives `Your reply was not the requested JSON. Reply with only the JSON object in the requested format.` in the same stage Session, and the corrective answer is the result only when it passes the check.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The run Agent remains idle while its Session log records state and ownership. The engine creates one short-lived child Agent/Session per model call under the live run Agent, so the stage restriction also masks tools registered in the run scope. It denies any remaining scoped tool execution. Each stage Session answers from one complete stage system prompt through `installDedicatedPrompt` from `@deepseek-ai/dsh-dedicated-prompt`: the deployment persona, the runtime context, and every tool schema stay out of the request. Each stage turn may make one model request, so a stage with a corrective turn makes at most two. `ctx.web` owns safe search and retrieval; the web tool's shared converter renders bounded HTML to Markdown. The source ledger attaches exact fetched text before its event, then records normalized findings and draft references. `ctx.sessions.flush` is the progress commit barrier. A failed caller flush can leave a discoverable run Session.

No runtime invariant companion is published because the run Session is the sole state authority, while attachment availability is checked when a report is read.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Run projection, commit order, owner checks, and recovery |
| [`src/engine.ts`](src/engine.ts) | Search, fetch, extraction, synthesis, stop, and report pipeline |
| [`src/stage.ts`](src/stage.ts) | Persisted stage turns, the corrective JSON turn, and admission |
| [`src/prompts.ts`](src/prompts.ts) | Versioned prompt templates, the stage system prompt, and the corrective message |
| [`src/config.ts`](src/config.ts) | Resolved budgets and validation |

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

Indirectly, through the `deep_research` consumer that controls which bounded progress and report pages reach its caller model.

#### KV Cache effect

Every stage Session's system prompt is `You are one stage of a research workflow. You have no tools and cannot search, browse, or run commands; work only from the text in the user message. Follow the output format the message asks for exactly.` unless its workflow supplies another. Each stage sends one bounded prompt in a fresh Session, so prior page text is included only when the next prompt explicitly selects it. The parent run adds no model-facing tool schema; a consumer can page the report without placing the whole research transcript in its caller context.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The `deep_research` consumer requires a caller Session and derives owner authority through this provider. It is enabled separately from the engine.
- URL citation checks match accepted fetched source URLs; they do not verify each factual claim.
- Profile ownership is only valid for an explicitly single-user composition; this provider does not authenticate separate human principals.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
