# Agent Note: Fantasy report slot locks and restart catch-up

Status: implemented

English | [中文](2026-09-27-fantasy-report-locks-and-catch-up.zh.md)

## Problem

The weekly fantasy reports recommended lineups without knowing which players Yahoo had already locked. On Sunday a Thursday-night starter cannot leave his slot and a bench player whose game has finished cannot start, yet the code-checked lineup accepted either move. A report whose slot fired while the harness was restarting, or whose run a restart interrupted, was never retried, and a completed report whose delivery handoff failed stayed only in research history.

## Decision

Yahoo roster rows carry `is_editable`; `0` means the player's slot can no longer change for the week. The `fantasy` capability exposes it as the optional `FantasyPlayer.slotLocked`, which the Yahoo provider sets only when the response carries a recognizable flag, so league player pages and unknown values stay unmarked. The `fantasy` tool serializes the field with rosters, and its description states what a locked slot means. The report writer sees `yahooSlotLocked` for every roster row, the lineup code check requires a locked starter to keep his current Yahoo slot and forbids starting a locked reserve player, and the rendered report names every locked player beside the lineup and marks each locked row. A locked starter is exempt from the availability check, because nothing can move him even when Yahoo later lists him out.

On plugin start, each team's latest slot at or before that moment is revisited once when it fired less than `catchUpWindowMs` ago (12 hours by default; `0` turns catch-up off). A Sunday slot uses the tighter of that window and `sundayCatchUpWindowMs` (2 hours by default), measured from the team's own Sunday slot, and the window is checked again after start spacing, so a caught-up Sunday report cannot start after its cutoff. A relative window per mode was chosen over an absolute kickoff time of day because each team's Sunday slot is already chosen relative to kickoff, and one slot arithmetic then serves every mode. The slot time comes from `latestMatchAt` in `dsh-cron`, which reuses croner rather than a second pattern evaluator.

The research history is the only durable record, so the run tag records what started the run and its fire time: `[fantasy-report:<team>:<season>:<week>:<mode>:<trigger>:<firedAt>]`. A catch-up starts only when the slot has no run or only interrupted runs and none of them was a catch-up, so a slot is caught up at most once. A completed report is handed to `cron/run-finished` again under its recorded run ID and fire time; the event requires listeners to deduplicate by outcome ID and fire time, and the Discord outbox does so through its delivery receipts, so a delivered report is not sent twice while an undelivered one finally reaches its channel. A slot whose run failed, was withheld, or was cancelled already produced its own notice and is left alone.

## Alternatives considered

- **Treat any slot without a completed report as missing** — rejected because a withheld or failed report already sent its notice, and a second run would send a second message for the slot.
- **Record deliveries in a new Session event or plugin store** — rejected because the listener's required deduplication already makes a repeated handoff safe, while a new durable record would add a second authority for the same fact.
- **Normalize timer fires to their scheduled minute and derive the fire time for redelivery** — rejected because a schedule may fire more than once per week and mode, and a queued run can start long after its slot, so a derived time can miss the listener's deduplication key.
- **Take opponents and kickoff times from Yahoo** — not possible: the anonymized roster, player, league, scoreboard, and game-week captures carry bye weeks and `is_editable` but no NFL opponent or game start time, and the documented v2 player resources have no schedule subresource; an unofficial feed stays out of scope.

## Consequences

A Sunday report can no longer recommend moving a player Yahoo has locked, and the reader sees which slots are fixed. A restart inside the window produces the missed report or delivers a completed one, never a duplicate for a slot. Catch-up covers only each team's latest slot and only at plugin start; a slot interrupted again during its catch-up, and a completed report whose tag carries no fire time, remain only in research history. Opponent and kickoff facts remain source-derived.
