# Agent Note: Durable personal-agent delivery and interrupted-run recovery

Status: implemented

English | [中文](2026-09-07-durable-personal-agent-delivery.zh.md)

## Problem

A personal agent's completed answer can outlive its network connection, while a reminder can outlive its mounted Agent. Treating transport failure as final delivery loses useful work. Keeping every conversation mounted avoids one reminder failure but consumes resources and still does not survive a process restart. A scheduled run also needs to distinguish a completed answer awaiting delivery from an interrupted action that cannot safely be repeated.

## Decision

The Discord gateway owns a bounded durable outbox. It persists complete text or formatted message bodies before posting, checkpoints acknowledged chunks, and retains completed delivery identities for a configured deduplication window. Transport retries resume queued messages without rerunning the agent. Rich bodies and transient interaction responses follow the [presentation decision](2026-09-07-discord-native-interactions-and-presentation.md). Conversation records checkpoint accepted final replies, so startup can recover committed output that has not reached the outbox. Queue capacity, content size, receipt retention, and retry delays are deployment configuration.

The gateway also inspects pending schedules only in its registered Discord sessions. It resumes the owning session when its earliest reminder is due and delegates dispatch to that session's existing Schedule plugin. Live Agent activity cancels cold timers and prevents idle release; `/stop` cancels both inbound and proactive turns. This preserves the agent-scoped ownership of [durable schedules](2026-08-05-durable-web-schedule.md).

Cron records a run reservation before opening its Session. Settlement records the terminal outcome and pending delivery together before handing it to a channel listener. A listener acknowledges only after durable acceptance; unacknowledged outcomes retry without model execution. Startup marks remaining reservations interrupted and reports them without rerunning their actions. Expression occurrences missed while the host was stopped are skipped; the scheduler arms the next future occurrence. Each fire reads the current continuity notes.

This decision supersedes the best-effort policy for automatic outcome delivery in [host cron with Discord delivery](2026-09-05-host-cron-with-discord-delivery.md) and [runtime-managed cron](2026-09-05-runtime-managed-cron-jobs.md). Direct `discord_send` tool calls retain their own immediate-send semantics. [Durable conversation routing](2026-09-05-discord-durable-conversations.md) remains the authority for channel identity and resume selection.

## Alternatives considered

**Rerun the agent after a failed post.** A completed run may already have changed external state. Persisting its answer avoids repeating those actions and paying for another model run.

**Keep all conversation Agents mounted.** This retains live timers but consumes resources indefinitely and cannot cover restart. The gateway can recover only its own sessions without changing the core scheduler into a global session scanner.

**Promise exactly-once Discord delivery.** A process can stop after Discord accepts a POST but before its local checkpoint lands. A local transaction cannot make that remote operation atomic; chunk checkpoints and bounded receipts reduce duplicates without hiding this ambiguity.

## Consequences

Delivery is at least once across the remote-POST/local-checkpoint crash window. Queue exhaustion refuses durable acceptance rather than discarding an older pending delivery. A cron job with pending output waits for acceptance before another run starts. Shutdown cancels timers and running work and waits for persistence and delivery operations to settle before closing their stores. These guarantees require one process per bot token and remain limited to configured Discord destinations; they do not provide Google account integration or automatic skill evaluation.
