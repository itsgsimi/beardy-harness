# Agent Note: Skill self-improvement through user scope, approval gating, and a turn nudge

Status: implemented

English | [中文](2026-09-05-skill-nudge-and-user-scope.zh.md)

## Problem

`skill_manage` could only write the current workspace's `.agents/skills`, so a procedure worked out in one repository was invisible everywhere else, and there was no place to keep durable personal procedures at all. The model also had no pressure toward capture: after inventing a multi-call workflow it simply stopped, because nothing ever asked whether the procedure was reusable. Meanwhile every mutation landed unconditionally, which is acceptable while a person watches but not in lanes that should stage writes for review.

## Decision

`skill_manage` gained a `scope` argument. The default `workspace` scope is unchanged; `user` writes flat files under `resolveDshHome()/skills`, the root the filesystem skill provider already scans as its `user-dsh` source, so no provider configuration changes are needed and user-scope skills load in every session. `enableUserSkillManagement` (default false) gates the scope per call; a disabled request refuses with a model-visible message. `requireApproval` (default false) routes create, update, and delete through the approval service at call time, following the memory-tool pattern: no mounted answerer is a refusal, not a fallback, and only `allowed-once` proceeds.

The nudge counts completed tool calls per Agent inside the current turn using a WeakMap tally fed by the `tools/post-execute` waterfall — which always delegates to `next()` — and checked at `agent/turn-stopping`. When a turn ends with at least `nudgeAfterToolCalls` (default 0, off) calls and no `skill_manage` call, one notice is injected through `agent.inject()` for the next admitted request, carrying a typed `skill-nudge` message source with the count; the tally is consumed at the stop, so each turn can owe at most one notice. The `skill_manage` tool description names capture as expected behavior. When management or the nudge is enabled, both catalog templates tell the model that a loaded skill whose result contains the compaction pruner marker `[... tool result middle pruned ...]` must be reloaded by name before its steps are followed.

## Alternatives considered

Counting session events or transcript messages was rejected: `tools/post-execute` is the exact quantity the nudge describes — completed tool calls in this agent's turn — and the WeakMap needs no durable state, surviving restarts being meaningless for a per-turn heuristic. A prompt-only rule ("save workflows you repeat") was rejected because it competes with task pressure at exactly the moment the model is finishing; the post-turn notice arrives when the work is done and the judgment is cheap.

Writing user-scope files under `~/.agents/skills` was rejected in favor of `$DSH_HOME/skills`: that root already exists as a scanned source with display-path support, while `.agents/skills` at home level would need provider changes and collides conceptually with per-workspace roots.

Approving inside the registry or filesystem layer was rejected: the decision being enforced is "this mutation by this agent," which belongs in the tool that makes it; the approval service may legitimately be absent, which is a refusal reason rather than an injection dependency.

## Consequences

Beardy presets open user scope and set the nudge at eight calls; the Discord lane additionally requires approval for every skill write, and the unattended lane keeps management disabled — its weekly review job therefore proposes merges and deletions in its delivered answer instead of applying them. The `skill-nudge` source kind joins `MessageSourceMap`, so every nudge is reconstructable from the session log; notices add one short retained message per eligible turn and break no earlier cached prefix.

Approval-gated skill writes refuse in lanes with no answerer, matching memory's stance: staging exists to be answered by a person, and an unanswered queue is not a license to write. User-scope skills are global authority — a bad saved procedure now follows every session — which is why the scope needs its own configuration switch rather than riding on `enableSkillManagement`.
