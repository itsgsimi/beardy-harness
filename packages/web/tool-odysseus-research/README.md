---
description: "Configure Beardy or another Harness profile to delegate research to an Odysseus worker and retrieve its saved reports."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-odysseus-research

English | [中文](README.zh.md)

## Summary

`odysseus_research` starts, inspects, reads, lists, and cancels Odysseus research jobs. The deployment selects the server, credential reference, endpoint, model, and research budget. Odysseus owns job execution and saved reports; Harness logs each tool call and result.

## Table of Contents

- [Configuration](#configuration)
- [Operations](#operations)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="configuration"></a>
## Configuration

Beardy includes a disabled `tool-odysseus-research` row. Enable it in the personal profile patch with all required values. Other profiles insert a row naming this package. Odysseus must support the `research:read` and `research:run` token scopes; browser-only research routes reject bearer starts. Store the token through the [credential provider](../../credentials/credentials-local/README.md), never in model input.

```yaml
- id: tool-odysseus-research
  disabled: false
  config:
    baseURL: http://127.0.0.1:7000
    tokenEnv: ODYSSEUS_RESEARCH_TOKEN
    endpointId: worker-4b
    model: Qwen3.5-4B
    disableThinking: true
    maxRounds: 1
    maxTimeSeconds: 60
    requestTimeoutMs: 30000
    maxResponseBytes: 1048576
    pageChars: 16000
```

Replace the example endpoint and model ids with the values registered in Odysseus. For Docker-hosted Odysseus, its model endpoint must reach the worker from inside that container. The configured model is sent on every start and never falls back inside this plugin. Schemastery rejects missing fields and out-of-range budgets at load; blank strings, fractional bounds, and URLs with credentials, query strings, or fragments also fail.

`disableThinking` defaults to `false`. Set it to `true` for a worker supporting `chat_template_kwargs.enable_thinking` to reserve short research calls for answer tokens; Odysseus must support the `enable_thinking` request field.

<a id="operations"></a>
## Operations

| Action | Input | Result |
|---|---|---|
| `start` | Non-empty `query` | Remote `id` and `status: running` |
| `status` | `id` | Remote status and progress |
| `report` | `id` | Saved report and sources through non-consuming `result-peek` |
| `list` | Optional title-search `query` | Active jobs and up to 20 saved reports |
| `cancel` | `id` | Whether cancellation was requested, not a claim that execution has stopped |

Read operations return JSON containing `text`, `next_offset`, and `total_chars`. Their `text` is a page of a JSON document; concatenate pages in order before parsing it. Pass each non-null `next_offset` back as `offset`. Offsets count Unicode characters. Status and list may change between reads; paging does not freeze the remote response. Missing reports, rejected tokens, and HTTP failures produce tool errors. Redirects are rejected, requests are never retried automatically, and the deadline includes response-body reads.

Cancelling an HTTP call or unloading the plugin leaves remote jobs alive. Keep the returned id, check `list` after an ambiguous start failure before retrying, and use `cancel` to stop unwanted work. Read reports again after a Harness restart using the recorded id. No runtime invariant companion is published: this stateless bridge owns no independently observable job registry; Odysseus owns job state.

<a id="model-experience"></a>
## Model Experience

### Research tool

#### What the model sees

The [tool definition](src/index.ts) exposes `odysseus_research` with five actions and explains asynchronous ownership, explicit progress checks, report paging, source citation, and untrusted evidence. The configured endpoint, model, and credentials are absent from its arguments. Results enter the ordinary Session tool-result log.

#### Token effect

One tool schema enters each request while enabled. Each read retains at most `pageChars` Unicode characters of payload plus the JSON wrapper and escaping. Reports and source URLs remain in history until compaction. The HTTP body limit bounds retained response bytes before JSON decoding.

#### KV Cache effect

The tool schema stays stable across calls. Tool results append to history; enabling or disabling the plugin changes the schema prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- There is no automatic completion notification or Harness background-job registration. The caller checks status explicitly. Research content can be incomplete even when Odysseus marks a job done; inspect its report and sources. The bridge does not verify citations or model quality. Saved-library results are limited to the first 20 matches; narrow the title query for older reports. Changing responses can shift page offsets.

<a id="dev-note"></a>
### Dev Note

The [decision record](../../../.agents/notes/implemented/feature/2026-09-07-odysseus-research-bridge.md) explains remote job ownership and explicit worker selection. A Harness completion watcher would need restart recovery and cancellation semantics before it could replace explicit reads.
