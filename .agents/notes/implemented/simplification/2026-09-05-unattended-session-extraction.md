# Agent Note: Unattended-session open transaction extracted from three ingress plugins

Status: implemented

English | [中文](2026-09-05-unattended-session-extraction.zh.md)

## Problem

Webhook ingress, the cron scheduler, and the Discord gateway each hand-rolled the same root-Session open: permission resolve, agent-preset resolve, workspace create, Agent creation with the preset mounted, attach, permission set, title, and rollback of whatever a failure lands in. The copies had already drifted in ways that mattered. Webhook alone called `agentPresets.standingKeyFor()` before creating, so cron- and Discord-opened Sessions skipped the standing-instructions warm-up their own preset declares. Webhook alone bound the creation `signal` into `agents.create()` and re-checked cancellation between steps; cron checked once after create, and Discord never passed the signal at all. Each copy also carried its own `sleep`, timeout race, and `lastAssistantText`.

## Decision

**One library owns the open.** New package `packages/session/unattended-session/` exports `openUnattendedSession(ctx, spec, signal)`: the full ordered transaction with standing key, signal binding, cancellation checks after standing/workspace/create/attach, and reported rollback (detach when attached, then dispose, each in its own `try`, warnings prefixed `unattended session:`). The spec carries the caller-chosen branded `sessionId`, preset names, workspace path, title, resolved `agentOptions`, and an optional extra `AgentSetup` composed after the preset mounts — webhook's creation-time model selection pins through it. Prompt admission deliberately stays with each ingress: provenance (`webhook`/`cron`/`discord` source blocks) is ingress-owned, so pulling it in would force a discriminated spec for no shared benefit.

**Turn helpers move too.** `sleep(ms, signal)`, `awaitTurn(agent, { timeoutMs, signal, wait? })` returning `'idle' | 'timeout'`, and `lastAssistantText(events, firstSeq)` replace the three local copies; the Discord poster keeps its resolved `wait` seam. Consumers keep their own outcome logging and disposal bookkeeping (cron's live-run cap, the gateway's per-channel map) because those are ingress policy, not open mechanics.

## Alternatives considered

- **Keep three copies and patch the drift.** Rejected: the review found the same class of miss in each copy (standing key, signal binding, cancellation checks), so the next addition would drift again; the copies differ only in spec values, which is exactly what a parameterized helper owns.
- **Pull prompt admission into the helper too.** Rejected: provenance blocks (`webhook`/`cron`/`discord`) are ingress-owned and shaped differently, so a shared admit would need a discriminated union with one member per caller — a layer that only forwards.
- **Place the helper in `dsh-agent` or `dsh-workspace`.** Rejected: neither owns the composition of presets, permission, workspace, title, and Agent creation; a dedicated leaf under `session/` names the role that exists.

## Consequences

Cron and Discord gained the standing-key warm-up and early cancellation they were missing; a pre-cancelled scheduler now fails a fire before creating workspace or Agent instead of disposing one. Webhook behavior is byte-identical: its call-order test passes unchanged, and its admit-failure rollback (after the open succeeded) stays in `dsh-webhook` with its own `webhook:` warning prefix — the shared helper never sees an admitted prompt. The two consumers' service-dependency import headers became identical enough to trip the jscpd clone gate; the cron header carries a narrow `jscpd:ignore` because the shared logic is the package itself and reordering imports to dodge the token threshold would only hide the mirror.
