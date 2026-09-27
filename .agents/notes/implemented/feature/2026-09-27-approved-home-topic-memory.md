# Agent Note: Approved home writes and topic memory

Status: implemented

English | [中文](2026-09-27-approved-home-topic-memory.zh.md)

## Problem

Beardy's curated memory and user skills live under the Harness home, outside a Session's workspace. Under `workspace-write`, a human approval did not let those tools save there. Scheduled runs could ask for approval but had no answerer tied to their delivery channel. The two core memory files also had too little room for durable household details.

## Decision

`tool-memory` and `tool-skill` can request a one-use filesystem allowance for one exact Harness-home file or a required `memories` or `skills` directory creation after `approval.request()` returns `allowed-once`. `fs-sandbox` accepts the allowance only under `workspace-write`, re-resolves the target, checks containment under the configured home, and rejects symlinked targets and ancestors through that home. The allowance never enters `writableRoots()`, shell, or subprocess policy. `read-only` remains a denial. The opt-in `allowApprovedHomeWrites` field requires `requireApproval`; Beardy presets enable both.

An active cron run associates its Agent with its configured delivery channel. The Discord gateway claims only that Agent's live approval request in the configured, allowed channel, and its button or reaction must address the request id or prompt message. Plain text cannot approve the run. Missing channels, listeners, controls, timeouts, and restarts leave the request unanswered.

The existing `memory` tool also exposes on-demand topic files under `memories/`. Topic writes preserve the owner's frontmatter and Rule, Why, History Markdown shape; remove marks a file retired. Read supplies a content version required for replace and remove. Topics never join baseline prompt assembly. Configurable file, count, and read limits bound this tier; core cap and ambiguity errors show current entries.

## Alternatives considered

**Add the Harness home to writable roots.** That would also grant broad writes to general filesystem, shell, and subprocess consumers under `workspace-write`.

**Treat approval as a permanent permission change.** A standing grant could outlive the approved action and would not identify the file the owner reviewed.

**Answer cron approvals through ordinary Discord text.** A bare reply does not identify a pending run's request and can be confused with a conversation reply.

**Inject every topic into each prompt.** That would spend baseline context on unrelated details and repeat the core-file cap problem.

## Consequences

The home exception is limited to trusted tool calls that have just received approval, and scheduled writes need a live configured Discord route. Topic reads incur a tool call, while core pointers can tell the Agent when to read one. A topic edit and a core pointer edit are separate versioned writes; the owner must reconcile a partially completed pair.
