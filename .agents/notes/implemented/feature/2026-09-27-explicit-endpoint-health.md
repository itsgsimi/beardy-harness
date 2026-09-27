# Agent Note: Explicit endpoint health and transition notices

Status: implemented

English | [中文](2026-09-27-explicit-endpoint-health.zh.md)

## Problem

An unattended model endpoint can remain unreachable for days while scheduled runs fail and nobody receives a clear provider alert. Conversation status alone does not expose endpoint reachability, and a second cron failure post would duplicate the gateway's existing outcome delivery.

## Decision

`dsh-health` polls only explicitly configured HTTP endpoints. Each probe has a unique name, URL, optional credential reference, and expected status. Consecutive failure and recovery thresholds change process-local state; the initial healthy observation is quiet. Down and recovered transitions enter the Discord gateway's durable outbox under an identity stable across acceptance retries. Endpoint checks continue during failed acceptance, and pending transitions retain their order until accepted. A per-kind cooldown limits repeated notices during flapping without hiding the first recovery. The Host exposes the current states through gateway `/status`.

Cron's durable job history supplies `/cron status [name]` with outcome, elapsed duration, failure cause, and next fire in both Discord and Web command input. The gateway enriches the one existing failed-run outcome notice with job, Session id, code, and next fire; it does not emit another cron health alert. The health plugin observes the cron outcome before gateway delivery and exposes only a read-only snapshot of the most recent failure fact for `/status`.

## Alternatives considered

**Probe a guessed universal models URL.** Provider endpoints, authentication, and status semantics differ; a guessed URL would report misleading health. Deployment configuration names each target.

**Store incidents or restart providers.** The Host has no authority to infer a safe recovery action from an HTTP result. The scheduler and gateway already own durable run history and delivery; another incident store would duplicate them.

**Post cron failures from health.** The gateway already accepts cron outcomes into an outbox. A second listener would produce duplicate user messages and unclear acknowledgement ownership.

## Consequences

An operator sees thresholded outage and recovery notices and can inspect current state without opening a model turn. An HTTP success proves only endpoint reachability, not generation quality. Probe state and the gateway's most recent cron failure reset on restart; durable cron history and accepted outbox entries remain with their existing owners.
