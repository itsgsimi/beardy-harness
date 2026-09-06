---
description: "Sidecar train/sample and train/label capture for the llm/stream waterfall and session events, for maintainers building an offline distillation dataset from real agent runs."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-training-export

## Summary

`dsh-training-export` writes a training-data sidecar beside each persisted session: one `train/sample` line per `llm/stream` call and one `train/label` line per completed turn, in the format `halorun dataset` reads (`docs/training-export-format.md` in the halorun checkout). It is listener-only — no prompt, no tool schema, no session-log event — so a build without this plugin reads an unaffected session log. Samples carry the exact request the adapter saw, the folded response, SHA-256 hashes of the system prompt and tool schemas, and a best-effort workspace snapshot; labels carry per-turn outcome counts (tool calls/errors, hooks, approvals, a `git diff --shortstat`, and any per-message ratings). The package lives under `packages/experimental/`: its contract can change without notice and no released product may depend on it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin beside a session-persisting composition to capture every completed model call and turn as training data. It only observes `ctx.llm`'s `llm/stream` waterfall and the session-event firehose; it never starts, resumes, or changes an agent.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `root` | required | Absolute directory for every session's sidecar; created on first write. |
| `providers` | required | Non-empty allow-list matched against `GenerateOptions.provider`. Gates only the per-turn `git` reads — every provider's samples are written regardless, and the `halorun dataset` reader applies its own filter. |
| `enabled` | required | Whether the listeners are active. No default: an omitted value fails config validation instead of silently doing nothing. |

```yaml
- id: training-export
  name: '@deepseek-ai/dsh-experimental-training-export'
  config:
    root: /var/lib/dsh/training-export
    providers: ['llama.cpp']
    enabled: true
```

### What to expect

For every `llm/stream` call whose `sessionId` is set, `<root>/<session-id-escaped>/samples.jsonl` gains one line after the stream settles — normally, on abort, or on a downstream throw — carrying the folded response and, on failure, a `{name, message, code?}` error. `<root>/<session-id-escaped>/meta.json` is written once, at the first sample. `<root>/<session-id-escaped>/labels.jsonl` gains one line per `turn/end`, with the turn's sample `seq`s, tool/hook/approval counts, a `git diff --shortstat` against the head captured at the turn's first allow-listed-provider sample, and any ratings recorded through `dsh-message-feedback` for that turn's assistant messages. A request with no `sessionId`, or one naming a session the store no longer holds, passes through completely untouched — this plugin only calls `next()` in that case, exactly like every other request.

Every disk write happens off a per-session queue (`fs.appendFile` chained on a promise tail); a write failure is logged through `ctx.logger` and never reaches the loop or the model call it observed.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The plugin wraps the `llm/stream` waterfall the same way `session-checkpoint-policy` does — `next()` is delegated to unconditionally when there is no live session, and wrapped exactly once otherwise. The wrapper folds `block-end` chunks into `response.content` in index order, keeps the last `usage` chunk, and records `finish` verbatim; a terminal `error`/`aborted` finish reason or a thrown rejection both populate `response.error`, and a thrown rejection is rethrown after being recorded — the sample is written either way. A separate `session/event` listener tracks turn/step position and the current turn's running counts (tool calls/errors, hook outcomes, approval counts, compaction-in-turn, and the assistant-message ids to look up ratings for), since `Session` exposes no public current-turn/step accessor. Both listeners share one `WeakMap<Session, …>` created inside `apply()`, so state is scoped to the plugin's own fiber and needs no ambient module-level state.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, the `llm/stream` wrapper, and the `session/event` listener |
| [`src/writer.ts`](src/writer.ts) | Per-session state, the append queue, and the `samples.jsonl`/`labels.jsonl`/`meta.json` writers |
| [`src/workspace.ts`](src/workspace.ts) | `git rev-parse`/`status`/`diff` reads (`execFile`, 5s timeout, never throws) |
| [`src/hash.ts`](src/hash.ts) | SHA-256 and canonical (sorted-key) JSON for `hashes.system`/`hashes.tools` |
| [`src/paths.ts`](src/paths.ts) | Session-id path escaping (mirrors `dsh-session-persistence-jsonl`'s `encodeSegment`) and the sidecar layout |

### Workspace capture

At most one `git rev-parse HEAD` + `git status --porcelain` pair runs per turn: the first sample whose provider is in the allow-list captures it, and every later sample that turn (allow-listed or not) reuses the same snapshot. A session with no `cwd`, or a turn whose only samples are non-allow-listed providers, never runs `git` at all. `git diff --shortstat` against that head runs once more at `turn/end` to build the label's `diff`.

</details>

**Runtime invariant:** No companion is published. The `samples`/`labels` relationship this plugin writes spans two sidecar files kept outside the authoritative session log by design; no in-process event stream or service carries that relationship for a runtime check to read, and this package's own tests cover it instead.

-----

<a id="model-experience"></a>
## Model Experience

None, as the model sees nothing this plugin adds — no prompt text, tool schema, or session-log event; it only observes the `llm/stream` waterfall and session events to write an external sidecar the model never reads.

#### KV Cache effect

The plugin never constructs or rewrites a request, so it cannot invalidate, extend, or replace any provider-side cache; every effect happens strictly after a response is already assembled.

## Known Limitations and Deferred Work

- **Ratings only at label time** — `train/label.ratings` is a snapshot taken when the turn ends; a rating added afterward is not picked up by this plugin. The format doc reserves `halorun dataset --refresh-ratings` for that case; this plugin does not implement it.
- **No cross-restart seq/turn recovery beyond the `samples.jsonl` line count** — the per-session `seq` counter resumes correctly across a process restart (it counts existing lines), but in-memory turn/step tracking and the open turn's running aggregate do not survive a restart or HMR reload: a turn already open when the plugin (re)loads produces no label for that turn.
- **`hooks[].name` is a synthesized `point:handlerId` join** — `hook/result` carries no single "hook name" field; the format doc's own example (`post-edit:test`) is illustrative, not a literal source field.
- **Two branches are untested rather than mocked** — `captureWorkspaceHead`'s `git status` failing right after `git rev-parse` succeeds (a real-`git` timing case no test setup reproduces without mocking `execFile`), and `resolveRatings`' path once `messageFeedback` is actually mounted (standing up its full storage-domain/session-persistence stack was judged disproportionate to this package's own tests; the mapping itself is exercised directly against `MessageFeedbackItem`/`MessageFeedbackListResult` shapes).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

See [`.agents/notes/implemented/feature/2026-09-06-training-export-sidecar.md`](../../../.agents/notes/implemented/feature/2026-09-06-training-export-sidecar.md).

</details>
