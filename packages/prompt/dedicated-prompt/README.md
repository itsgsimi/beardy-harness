---
description: "Agent-scope isolation for single-purpose model turns, used by camera-watch classification and research-local stages: one complete system prompt, no tool schemas or runtime context, and a fixed temperature."
kind: "package-library"
---

# @deepseek-ai/dsh-dedicated-prompt

English | [中文](README.zh.md)

## Summary

`installDedicatedPrompt` makes one Agent scope answer from a caller-supplied complete system prompt. The deployment persona, every other prompt section, the runtime context, and every tool schema stay out of that scope's requests, and each request carries the caller's temperature. Camera-watch classification and research-local stage turns call it from the `setup` of their own short-lived Agents. It uses only public System Prompt and Agent extension points and returns one disposer.

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

### When to use it

Use it for a model call that must see exactly one prompt and no tools, such as a classifier or a JSON-producing stage, while still running as an ordinary logged Agent turn. [camera-watch](../../camera/camera-watch/README.md) and [research-local](../../research/research-local/README.md) are the current consumers.

### Entry point

```text
import { installDedicatedPrompt } from '@deepseek-ai/dsh-dedicated-prompt'

ctx.agents.create({ setup: agentCtx => {
  installDedicatedPrompt(agentCtx, { systemPrompt: STAGE_PROMPT, temperature: 0.2 })
} })
```

The call returns a disposer that removes all four contributions. Disposing the Agent scope removes them as well. The [`DedicatedPrompt`](src/index.ts) interface states each field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The helper registers four contributions on the Agent's scoped context. A `complete` section named after the persona prefix section, at the deployment persona-prefix order, shadows every other section. `suppressRuntimeContext()` drops runtime context blocks. A `system-prompt/assemble` listener clears the tool schemas after the rest of the chain runs, so tools that other plugins register later in the scope stay hidden too. An `agent/request` listener sets `temperature`, which the logged request header records.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `installDedicatedPrompt` and `DedicatedPrompt` |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [System prompt subsystem](../../../docs/subsystems/system-prompt.md) — sections, complete sections, and assembly.
- [Agent package](../../core/agent/README.md) — Agent scopes and the `agent/request` waterfall.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through camera-watch classification and research-local stage turns, which own the complete system prompt text and the temperature that this helper applies to their Agent scopes.

#### KV Cache effect

No direct invalidation; each consumer's dedicated prompt is a stable prefix for its own Agent scope, and the consumer owns any change to that text.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Tool execution is not guarded** — the helper hides tool schemas but does not refuse tool calls; each caller installs its own `tools.guard` with its own refusal text.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
