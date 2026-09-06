# Agent Note: Training-export sidecar plugin

Status: implemented

## Problem

Nightly distillation needs the teacher's real derived requests and their outcomes, captured where the request is actually assembled — `deepseek-harness` — not reconstructed later from the session log. The session log has messages, tool calls/results, and turn outcomes, but not the exact post-compaction, post-splice `messages[]` an adapter saw, and re-deriving that offline means reimplementing dsh's context assembly. `SessionEventMap` is also fail-closed on read: a log containing new `train/*` events would be refused by any build without the owning plugin, so the export cannot be session-log events.

## Decision

`@deepseek-ai/dsh-experimental-training-export` wraps the `llm/stream` waterfall (the same seam `session-checkpoint-policy` wraps) and listens to the session-event firehose, writing two append-only sidecar files per session under a configured `root`: `samples.jsonl` (one `train/sample` line per model call whose `sessionId` is set) and `labels.jsonl` (one `train/label` line per `turn/end`), plus a `meta.json` written once. The wire contract is `docs/training-export-format.md` in the halorun checkout; this package is the writer half, `halorun dataset` the reader.

The wrapper folds the downstream `StreamChunk` stream into a response (`block-end` blocks in index order, the last `usage`, the terminal `finish`, and an `error` populated from either a terminal `error`/`aborted` finish reason or a caught-and-rethrown exception) and enqueues the sample write from a `finally` block, so a sample is written whether the call completed, aborted, or threw. A separate `session/event` listener tracks turn/step position (`Session` exposes no public current-turn/step accessor, so this plugin tracks `turn/start`/`step/start`/`step/end`/`turn/end` itself) and the open turn's running counts — tool calls/errors, `hook/result` outcomes, approval counts, compaction-in-turn, and the assistant-message ids to look up ratings for — closing that aggregate into a `train/label` line at `turn/end`.

Both listeners share one `WeakMap<Session, SessionExportState>` created inside `apply()`: state lives in the plugin's own fiber closure, not module-scope ambient state, and needs no explicit teardown — it is garbage-collected with the `Session`. Every disk write goes through one per-session promise-chain queue (`fs.appendFile`), and every failure is caught and logged through `ctx.logger` inside the queue itself, so nothing from this plugin ever reaches the agent loop.

Workspace capture (`git rev-parse HEAD` + `git status --porcelain`, `execFile`, 5s timeout, never throws) runs at most once per turn: the first sample whose provider is in the configured `providers` allow-list captures it, and every later sample that turn reuses the snapshot; a session with no `cwd` skips it permanently. `git diff --shortstat` against that head runs once more at `turn/end` to build the label's `diff`. `providers` gates only these `git` reads — every provider's samples are written regardless, matching the halorun-side reader owning the provider filter.

Optional per-message ratings come from `ctx.get('messageFeedback')` (the package's optional-service pattern: `import type {} from '@deepseek-ai/dsh-message-feedback'` for the `Context` augmentation, `ctx.get(...)` at the call site, mirroring `dsh-tools`' optional `approval` service) — `[]` when the service is not mounted.

### Package placement

The package lives at `packages/experimental/training-export` as `@deepseek-ai/dsh-experimental-training-export` (`private: true`, no `publishConfig`), following every other package under `packages/experimental/`: `check-workspace-constraints` requires the `dsh-experimental-` npm prefix for any package in that directory, and release packages must never depend on one. The nightly-distill plan's own working name for this capability is "`dsh-training-export`"; the shipped npm name and Cordis plugin `name` (`training-export`) differ from that shorthand only by the mandatory experimental prefix.

## Alternatives considered

**Session-log `train/*` events.** Rejected: `SessionEventMap` is required-on-read (fail-closed), so any build without this plugin would refuse a log containing them. A sidecar avoids the format-version bump and the refusal entirely, the same reasoning `dsh-message-feedback` already applies to ratings.

**A runtime invariant that re-reads `samples.jsonl`/`labels.jsonl` to check `train/label.samples` against written seqs.** Rejected: every existing package invariant in this workspace checks `session.events` or another owned in-process structure, never file contents — the sidecar files are deliberately outside that authoritative event stream. `src/invariant.ts` is a documented empty companion for this reason; the relationship is instead covered by this package's own tests.

**Module-scope ambient `WeakMap`, mirroring `session-telemetry`'s `handoffCursor`.** Rejected: that pattern exists there because a re-adopting fiber must resume history across HMR reloads. This plugin has no such requirement — a fiber-local `WeakMap` created inside `apply()` is simpler and is exactly what session-checkpoint-policy-style listener-only plugins already do.

## Consequences

- A session persisted with no `dsh-experimental-training-export` mounted is unaffected — nothing it wrote changes shape, and no format-version bump was needed.
- A turn already open when the plugin (re)loads (process restart, HMR) produces no `train/label` line for that turn: in-memory turn tracking does not survive across a reload, unlike the `seq` counter (recovered by counting existing `samples.jsonl` lines).
- Ratings are a snapshot taken at `turn/end`; a rating added afterward needs the format doc's deferred `halorun dataset --refresh-ratings` path, not this plugin.

## Testing

Per-file coverage on `packages/experimental/training-export/src` is 96% branches, short of the `test:coverage` gate's 100% in two places, both left as deliberate gaps: `captureWorkspaceHead`'s `git status` failing immediately after `git rev-parse` succeeds (real-`git` timing no test setup reproduces without mocking `execFile`), and `resolveRatings`' path once `ctx.get('messageFeedback')` is actually mounted (its full storage-domain/session-persistence stack was judged disproportionate to stand up here; the rating-mapping logic itself has no other branches beyond those two calls). Every other branch, including workspace-capture reuse across two calls in one turn, seq/meta resumption across a simulated restart, and every tracked session-event type both inside and outside an open turn, is covered.
