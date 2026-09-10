---
description: "Shared open-and-await machinery for unattended entry points, for maintainers wiring webhook, cron, or Discord ingress or debugging a half-opened Session."
kind: "package-reference"
---

# @deepseek-ai/dsh-unattended-session

English | [中文](README.zh.md)

## Summary

`dsh-unattended-session` opens a root Agent Session for webhook, cron, and Discord entry points in one rollback-safe transaction. It resolves presets, creates the workspace and Agent, binds cancellation, attaches, applies permissions, and titles the Session. Each caller retains prompt admission and supplies its Session id prefix, title, model options, and extra setup. Shared helpers (`awaitTurn`, `sleep`, and `lastAssistantText`) bound turn waits. This is a library, not a Cordis plugin.

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

As an ingress author, build a spec, open through the helper, then admit your own prompt. As a deployment, you configure nothing here; every tunable lives in the consumer plugin's own configuration.

### Opening a Session

`openUnattendedSession(ctx, spec, signal)` takes an `UnattendedSessionSpec`: the caller-chosen branded `sessionId`, `agentPreset`, `permissionPreset`, absolute `workspacePath`, `title`, `agentOptions` (provider, model, optional `maxTokens`), and an optional `setup` composed inside the Agent scope after the preset mounts — webhook uses it to pin a creation-time model selection. It returns the `sessionId`, the `AgentHandle`, and the attached `Workspace`, which the caller keeps for later detach or disposal. A failure or cancellation before Agent creation leaves nothing behind; afterwards the Agent is disposed, and detached first when the attach had succeeded.

### Waiting for one turn

`awaitTurn(agent, { timeoutMs, signal, wait? })` races the Agent's idle promise against the bound and reports `'idle'` or `'timeout'`; a rejected wait seam or a rejected idle promise also report `'timeout'`. `sleep(ms, signal)` is the default delay seam. `lastAssistantText(events, firstSeq)` returns the last non-empty assistant text committed at or after `firstSeq`, which is what an unattended caller posts back or logs.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the transaction; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

One owned open sequence so three ingress plugins cannot drift. The order and rollback below are the contract every consumer test pins: permission resolve, preset resolve, standing key, abort check, workspace create, abort check, Agent creation (preset mounted inside `setup`, signal bound), abort check, attach, abort check, permission set, title.

### Source map

| File | Role |
|---|---|
| [`src/open.ts`](src/open.ts) | Spec and result types, the open transaction, and reported rollback |
| [`src/turn.ts`](src/turn.ts) | `sleep`, the bounded `awaitTurn` race, and `lastAssistantText` |

### Rollback contract

A failure inside the post-create region detaches (only when attached) and disposes in that order; each rollback step runs in its own `try`, and a rollback failure is reported through `ctx.logger.warn` with the `unattended session:` prefix while the original error propagates. The caller's `signal` is both bound into Agent creation and re-checked between steps, so a cancelled scheduler or listener never leaves a mounted, running Session.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the open transaction is not enough. They move from the consumers to the services the transaction drives.

- [Webhook ingress](../../webhook/webhook/README.md) — opens a Session per verified delivery and admits its own prompt.
- [Cron scheduler](../../cron/cron/README.md) — opens one Session per job fire under a turn bound.
- [Discord gateway](../../discord/discord-gateway/README.md) — opens one Session per conversing channel.
- [Agent presets](../../preset/agent-presets/README.md) — resolution, standing keys, and mounting that the transaction performs first.
- [Workspace registry](../../workspace/workspace/README.md) — workspace creation and Session attachment.

-----

<a id="model-experience"></a>
## Model Experience

### Opened-Session requests

#### What the model sees

Nothing directly from this package. It issues no model request and writes no session event; the opened Session logs its ordinary events through `ctx.agents.create()`, and each ingress admits its own prompt with `followup()` as a `user/message` carrying that ingress's provenance. Rollback failures reach `ctx.logger.warn`, never the Session log or the model surface.

#### Token effect

No token use of its own; the opened Session consumes tokens only under the prompts its ingress admits.

#### KV Cache effect

None. No main-request invalidation and no request framing of its own.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the accepted open-transaction shapes. They are current package constraints.

- **Reported rollback** — a failing detach or disposal is warned about, not retried or escalated; the original failure propagates unchanged.
- **No durable open record** — a half-opened attempt leaves only runtime warnings; the Session log begins with Agent creation and carries no transaction state of its own.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The helper holds no state between opens; ordering, rollback, and cancellation are exercised by its own specs and pinned by the three consumer plugins' call-order tests.
