# Agent Note: Discord turn progress notice

Status: implemented

English | [中文](2026-09-29-discord-turn-progress-notice.zh.md)

## Problem

On 2026-09-29 a research-style Discord request ran five tool steps with medium thinking on the local model. After the 600000 ms `turnTimeoutMs` the gateway released the conversation, discarded the answer, and posted a timeout notice. The deployment raised `turnTimeoutMs` to 1800000, but during a long turn the channel showed only the typing indicator and the 👀 reaction, so the user could not tell a slow turn from a stuck one.

## Decision

`@deepseek-ai/dsh-discord-gateway` adds the validated `turnProgressNoticeMs` field, default 180000. `0` disables the notice, and `assertConfig` rejects any other value that is not shorter than `turnTimeoutMs`. `runTurn` arms one timer through the router's `wait` seam after it hands the message to the Agent. When the timer fires first, the router posts `TURN_PROGRESS_NOTICE` through the existing `notice` path, so it enters the durable outbox and, with `richMessages`, renders as a card with the conversation controls. The notice goes to the turn's own channel, so a user lane's notice reaches that user's direct messages.

The timer signal combines the router's shutdown signal, the channel input signal that `/stop` and `/new` abort, and a per-turn controller. `runTurn` aborts the controller in its `finally` block when the turn settles or times out; `releaseConversation` and `dispose` abort it through `LiveConversation.cancelProgress`. The callback re-checks the combined signal, so a delay seam that resolves after cancellation posts nothing. The notice does not change the turn or the Session log.

Messages that arrive during the turn keep today's serialization: they queue on the channel tail and run only after `runTurn` returns, so they arm their own notice when their turn starts and never share or re-arm the running turn's timer. The notice callback only enqueues a post through `track`; it never touches the tail chain or the turn's state.

## Alternatives considered

**Repeat the notice at an interval.** One notice answers "is it still running"; repeated posts add channel noise while the typing indicator already repeats.

**Make the notice text configurable.** Every other gateway notice is fixed text; the text names no deployment detail, so a config field would only add surface.

**Arm the timer for preset commands and proactive turns.** The reported wait came from an inbound message; preset command turns and proactive turns keep their current presentation.

## Consequences

A turn waiting on an approval or question can still post the notice after the threshold. The notice is not model-visible and is not written to the Session log, so no snapshot changes. Tests use Vitest fake timers for the threshold, settlement, disabled, serialized-message, timeout, `/new`, disposal, and lane paths, and a manual delay seam for late resolution.
