# Agent Note: Durable Discord conversations with resume, commands, and proactive delivery

Status: implemented

English | [中文](2026-09-05-discord-durable-conversations.zh.md)

## Problem

The Discord gateway answered messages but forgot everything when the process stopped: the channel-to-session map lived in memory, so a restart silently started every person over, and any promised check-back died with the turn that made it. A person typing several short messages got one answer per message because each arrived as its own turn. There was no way to reset or inspect a conversation from Discord itself, no feedback while a turn ran (a minute of silence reads as a broken bot), and guild channels could not be opened to more than their owner without every post in them starting work.

## Decision

One durable record per channel plus four behaviors built on it. `domain.ts` declares a storage-domain table (`discord_gateway`, versioned zod rows) mapping channel id to session id, agent preset, workspace path, and open/last-inbound timestamps; the router writes it when a conversation opens and stamps each arrival. On the next message the router resumes that session through a new `resumeUnattendedSession` helper in `@deepseek-ai/dsh-unattended-session` — the open transaction minus titling — and treats `SessionPersistenceNotFoundError` as "the log is gone": warn, drop the record, start fresh. `idleReleaseMs` disposes the live Agent handle after silence while keeping the record (cheap resume later), `conversationMaxAgeMs` expiry makes the next message replace the session, and inbound messages inside `inboundDebounceMs` join newline-wise into one turn (`0` opts out).

Feedback and control ride three smaller seams. The gateway repeats Discord's typing endpoint every eight seconds while an inbound turn runs (`typingIndicator`, delivered through a new `postTyping` export of `@deepseek-ai/dsh-tool-discord`). Each `READY` dispatch hands the bot's own user id to the router, and with `guildRequireMention: true` a guild post is admitted only when it mentions that id or replies to one of the bot's messages; direct messages keep answering unconditionally. `/new`, `/status`, and `/stop` are registered into each conversation Agent's scope by `commands.ts` (so preset commands mount them with the ordinary registry machinery) and executed through `ctx.commands.execute`; they bypass the per-channel serial tail so `/stop` reaches a running turn, and when no agent is live the router answers them from durable state instead of opening a session by surprise. Proactive delivery — reminders created with `dsh-schedule`, which the `beardy-discord` preset now mounts — posts the final assistant text of any turn that settles while the conversation is idle: the listener rides the `agent/status` idle transition because `turn-stopping` fires before the final text commits, and a per-conversation sequence floor keeps router-awaited replies and proactive scans from double-posting.

## Alternatives considered

Storing the channel map in session metadata or a dedicated service was rejected: `dsh-storage-domain` is the sanctioned versioned KV seam with zod-validated rows, needs no new Service Definition, and its lifecycle (open at apply, close at stop) matches the plugin's.

Duplicating the open transaction inside the gateway for resume was rejected because the permission resolve, preset mount, workspace attach, rollback, and permission-set steps are exactly `openUnattendedSession`'s; a second copy would drift on the first fix. The helper lives in the shared package next to its sibling, with titling left out since a resumed session keeps its original title.

Proactive delivery on `turn-stopping` was rejected after measurement: the event fires before the final assistant text enters the log, so it would post the previous turn's text. The idle transition sees the committed text and also covers turns started by anything else mounted on the agent; inbound turns are excluded by the busy flag the router already owns.

Joining debounced messages into one user message was chosen over a queue of separate turns: one turn per thinking burst matches how the person writes, keeps replies proportionate, and avoids interleaving answers with a still-typing author. Reply-optional mention gating (not mention-only) was chosen because replying to one of the bot's messages is the natural continuation gesture in a guild thread.

## Consequences

Automatic outcome delivery and cold reminder recovery follow the [durable delivery decision](2026-09-07-durable-personal-agent-delivery.md). Native command discovery and message controls follow the [interaction presentation decision](2026-09-07-discord-native-interactions-and-presentation.md).

The gateway now injects `commands` and `storageDomain`; every composition mounting it must provide both, which the base bundle already does. Records are deleted on `/new` and expiry but kept after turn timeouts so the next message still resumes the same history. Existing deployments with allowlisted guild channels see a behavior change: mentions are required by default and `guildRequireMention: false` restores answering every post. Each active channel costs one extra Discord API call per eight seconds while its turn runs, abandoned when the indicator endpoint fails or the token is gone. Resume keeps a session's prompt prefix intact across restarts, which favors the KV cache compared to the old fresh-session-per-restart behavior. Idle answers to `/new`, `/status`, and `/stop` never enter a session log because no agent exists to record them; that gap is documented in the package README rather than faked with a synthetic event.
