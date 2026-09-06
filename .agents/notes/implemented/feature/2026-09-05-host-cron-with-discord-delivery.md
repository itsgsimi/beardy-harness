# Agent Note: Host-scoped cron jobs with Discord delivery

Status: implemented

English | [中文](2026-09-05-host-cron-with-discord-delivery.zh.md)

## Problem

Some agent work has no session to live in. A morning brief that summarizes feeds and weather, or a nightly repository check, must run at a wall-clock time with nobody present, no open Session, and no model turn already in progress to attach it to. `@deepseek-ai/dsh-schedule` is the shipped scheduler and does not cover this: its after, at, and fixed-rate rules are agent-scoped and durable over one Session's event log, so a rule needs an owning Agent that is already running. Nothing in the spine could start work on a timetable, and nothing could carry the result to a place a person actually looks.

## Decision

Three packages, each owning one job.

`@deepseek-ai/dsh-cron` (`packages/cron/cron/`) mounts jobs declared in configuration through croner, which owns cron-expression parsing, timezones, and daylight-saving arithmetic. `assertConfig` rejects duplicate job names, an unparseable expression or timezone, a relative workspace path, and a non-positive bound at load, so a job that could never run stops startup instead of failing silently at 07:00. Each fire opens a fresh Session through the same order every other entry point uses — agent preset resolve, permission preset resolve, workspace registration, `agents.create`, attach, permission apply, title — and hands over the job prompt as one user message whose source is `{ kind: 'cron', jobName, scheduledFor }`. A run that is still going when its next fire arrives is logged as skipped; `turnTimeoutMs` bounds one answer; `maxLiveRuns` releases the oldest mounted Sessions. The package reports an outcome (`answered`, `no-text-answer`, `timed-out`, `failed`) and delivers nothing itself.

`@deepseek-ai/dsh-tool-discord` (`packages/discord/tool-discord/`) gives the model one write path: `discord_send` posts to the channel named in configuration, splitting bodies over Discord's 2000-character limit into consecutive messages, waiting out HTTP 429 within a ceiling, and rewriting `@everyone`, `@here`, and role pings before posting. The bot token resolves from a credential reference at call time, so no token appears in a composition file. It speaks Discord REST directly — no SDK, no gateway connection, no cached Discord state — which keeps the dependency surface at one HTTP call per post.

`@deepseek-ai/dsh-discord-gateway` (`packages/discord/discord-gateway/`) closes the loop for people who want to work from Discord: one Gateway v10 websocket reads `MESSAGE_CREATE`, and a direct message from an allowlisted user opens a Session, mounts the configured preset pair in a fixed workspace, and posts the answer back to the channel it came from. One channel keeps one Session, so follow-ups continue the same conversation and are visible in the Web UI beside every other session.

The `beardy` bundle wires all three: `discord_send` and the gateway mount when `DISCORD_BOT_TOKEN` resolves, and one job posts the morning brief at 07:00 in the machine's timezone. Jobs, feeds, and destination stay configuration, so a profile patch changes them without a code edit.

## Alternatives considered

`discord.js` or another platform SDK was rejected: the integration needs one websocket that identifies and reads one event type, plus one POST per post. An SDK brings an object cache, intent orchestration, and a dependency tree sized for building a bot application, all of which would need their own invalidation reasoning here. The raw protocol is versioned by Discord and small enough to own, and its opcodes and limits are named constants with tests.

Hand-rolling cron parsing was rejected in favour of croner, which owns expression parsing, IANA timezones, and daylight-saving arithmetic — a maintained dependency that removes both the code and the date-boundary tests a hand-rolled parser would need (see the repository policy on dependencies over hand-rolling). The package keeps only a thin `Scheduler` seam around it so jobs can be mounted in tests without waiting for wall-clock time.

Making jobs runtime-editable durable state was deferred rather than rejected: the stated future surface — a person or an agent creating and pausing schedules, with a Client view — needs its own persistence and identity decisions, and shipping configuration first keeps the first job honest. Extending `dsh-schedule` instead was rejected because its rules are agent-scoped over one Session's event log; a host job that no Agent owns has no record to live in there.

A delivery queue with retry across restarts was rejected for now: it introduces durable state, delivery identity, and duplicate-suppression questions that this change does not need. A send that cannot complete fails its tool call visibly, and the run's outcome records it.

## Consequences

A scheduled run is an ordinary Session: it appears in session search, its log reconstructs every tool call, and `discord_send` results are model-visible and logged like any other tool result. Nothing new had to be invented for unattended context assembly, permissions, or titles.

Delivery is best-effort at the moment of the call. A send that exhausts its retries fails the tool call and is not queued; a run during Discord downtime loses that message. Adding durability means a delivery store with its own retry identity, which is deliberately not part of this change.

Job state is configuration only — there is no Service method or model-facing tool that creates, edits, pauses, or deletes a job at runtime. The stated future state (a person or agent managing schedules, and a Client surface for them) needs a durable host-scoped job store and its own persistence decision; `dsh-schedule`'s session-event mechanism does not extend to jobs no Agent owns, so that is a separate capability rather than a flag on this one.

Channel-to-Session continuity is recorded durably, so a restart resumes each Discord channel on its previous Session ([decision](2026-09-05-discord-durable-conversations.md)). Guild channels deliver empty bodies until Message Content intent is enabled for the application in the Discord developer portal; direct messages arrive complete without it. Exactly one process may identify with a bot token, or every inbound message gets answered twice.
