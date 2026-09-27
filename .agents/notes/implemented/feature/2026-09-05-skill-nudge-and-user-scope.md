# Agent Note: Skill self-improvement through user scope, approval gating, and a turn nudge

Status: implemented

English | [中文](2026-09-05-skill-nudge-and-user-scope.zh.md)

## Problem

`skill_manage` could only write the current workspace's `.agents/skills`, so a procedure worked out in one repository was invisible everywhere else, and there was no place to keep durable personal procedures at all. The model also had no pressure toward capture: after inventing a multi-call workflow it simply stopped, because nothing ever asked whether the procedure was reusable. Meanwhile every mutation landed unconditionally, which is acceptable while a person watches but not in lanes that should stage writes for review.

## Decision

`skill_manage` gained a `scope` argument. The default `workspace` scope is unchanged; `user` writes flat files under `resolveDshHome()/skills`, the root the filesystem skill provider already scans as its `user-dsh` source, so no provider configuration changes are needed and user-scope skills load in every session. `enableUserSkillManagement` (default false) gates the scope per call; a disabled request refuses with a model-visible message. `requireApproval` (default false) routes create, update, and delete through the approval service at call time, following the memory-tool pattern: no mounted answerer is a refusal, not a fallback, and only `allowed-once` proceeds.

Skill authorship stays with the top-level session that dispatched the work, because a child often runs a caller-written read-only task. The durable child origin excludes it after resume as well. The Session-wide timing and lifetime of the notice belong to [Session-scoped skill nudges and draft lint](2026-09-27-skill-nudge-quality.md). When management or the nudge is enabled, both catalog templates tell the model that a loaded skill whose result contains the compaction pruner marker `[... tool result middle pruned ...]` must be reloaded by name before its steps are followed.

## Alternatives considered

A prompt-only rule ("save workflows you repeat") was rejected because it competes with task pressure while the model is finishing; the post-turn notice arrives when the work is done. The process-local tally was later replaced by the [Session projection decision](2026-09-27-skill-nudge-quality.md), which owns the completed-turn and resume requirements.

Writing user-scope files under `~/.agents/skills` was rejected in favor of `$DSH_HOME/skills`: that root already exists as a scanned source with display-path support, while `.agents/skills` at home level would need provider changes and collides conceptually with per-workspace roots.

Approving inside the registry or filesystem layer was rejected: the decision being enforced is "this mutation by this agent," which belongs in the tool that makes it; the approval service may legitimately be absent, which is a refusal reason rather than an injection dependency.

## Consequences

Beardy Web and Discord presets open user scope and set the nudge at 20 calls; skill writes require approval, and the unattended lane keeps nudges disabled. The `skill-nudge` source kind joins `MessageSourceMap`, so each notice is reconstructable from the Session log and adds one retained message after the reusable request prefix.

Approval-gated skill writes refuse in lanes with no answerer, matching memory's stance: staging exists to be answered by a person, and an unanswered queue is not a license to write. User-scope skills are global authority — a bad saved procedure now follows every session — which is why the scope needs its own configuration switch rather than riding on `enableSkillManagement`.
