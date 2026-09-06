---
description: "Inbound Discord conversations: a gateway websocket that turns direct messages from allowlisted users into durable DSH sessions with resume, slash commands, typing feedback, proactive delivery, and approval and question answering, for users who want to work with an agent from Discord."
kind: "package-reference"
---

# @deepseek-ai/dsh-discord-gateway

English | [中文](README.zh.md)

## Summary

The package lets a person converse with a DSH agent from Discord. It holds one Gateway v10 websocket, identifies with the bot token resolved from a credential reference, and reads `MESSAGE_CREATE` events: a direct message from a user in `allowedUserIds` — or an addressed post in an allowlisted guild channel — opens a session on this Host, mounts the configured agent preset and permission preset in the configured workspace, hands the text over as a normal user message carrying Discord provenance, and posts the agent's answer back to the channel it came from. Each channel keeps one conversation whose identity is recorded durably, so restarts, idle releases, and reminders all continue the same session, and it appears in the Web UI beside every other session. When a tool needs permission or the agent asks a question, the prompt appears in the channel and the person answers by reaction or reply. Reconnects double the delay up to a ceiling; `enabled: false` mounts the plugin without dialing out.

## Table of Contents

- [Conversation behavior](#conversation-behavior)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="conversation-behavior"></a>
## Conversation behavior

- **Durable conversations.** Each channel's session id, preset, and workspace are written to a storage-domain record the moment the conversation opens. After a restart or an idle release (`idleReleaseMs`), the next message resumes that session instead of starting over; once `conversationMaxAgeMs` of silence passes, the next message starts a fresh session and replaces the record.
- **Message batching.** Messages that arrive within `inboundDebounceMs` join into one turn so a person typing several short messages is answered once; `0` answers every message on its own.
- **Typing feedback.** While an inbound turn runs, the gateway repeats Discord's typing indicator (`typingIndicator`) until the answer posts.
- **Guild gating.** Guild channels must appear in `allowedChannelIds`, and with `guildRequireMention: true` (the default) only messages that mention the bot or reply to one of its messages are answered. Direct messages from allowed users are always answered.
- **Slash commands.** `/new` releases the conversation so the next message starts a fresh session, `/status` reports the session id, presets, live-or-released state, and whether a turn is running or a request waits for an answer, and `/stop` cancels the running turn and any waiting request. Any other slash command runs on the live agent through the ordinary command registry (`/compact` and friends); commands that arrive while no conversation is live answer with guidance instead of opening a session by surprise.
- **Proactive delivery.** A turn the gateway did not start — a `dsh-schedule` reminder, for example — posts its final assistant text to the channel when the agent goes idle, so promised check-backs reach the person who asked.
- **Approvals and questions.** When a tool call needs permission or the agent asks a question, the prompt posts to the channel: react ✅ to allow once or ❌ to reject, or reply `yes` / `no`; questions are answered with option numbers (a comma-separated list for multi-select) or free text. `answerers` chooses which reply forms count (`reaction`, `text`), and requests expire after `approvalTimeoutMs` / `questionTimeoutMs` with a notice in the channel. One request waits per channel at a time: a newer request cancels the older one.

<a id="model-experience"></a>
## Model Experience

### Inbound message

#### What the model sees

Each admitted Discord message arrives as one user-role message whose text is the message body, bounded by `maxInputChars`; messages joined by the debounce window arrive as one message with newline-joined lines. The message carries provenance the surfaces render as a notice: the sender's Discord user id, the channel id, the message id, and a summary naming the channel. Nothing else about Discord reaches the model — no member roles, no attachment metadata, no other messages in the channel — so an agent learns the channel's earlier content only from the session history this package already appended.

#### Token effect

One user message per admitted inbound message (debounced joins count as one), plus the reply's tool-call and result messages when the agent answers through `@deepseek-ai/dsh-tool-discord`. Preset slash commands run as ordinary logged command turns on the same session. Conversation history grows like any other session; nothing is re-sent that the log already holds.

#### KV Cache effect

Inbound messages append to an existing session, so earlier turns stay reusable and only the new message and following turns form a fresh suffix. A channel's first message creates a session whose preset composition forms the initial prefix; resume after restart or idle release keeps that prefix warm rather than rebuilding it on a new session.

### Approval and question prompts

#### What the model sees

An approval decision reaches the model as the ordinary approval outcome — allowed once, rejected, or cancelled — exactly as on any other surface; a question answer arrives as the standard `ask_user` answer record. Nothing Discord-specific rides these exchanges beyond what the same approval or question already carries elsewhere.

#### Token effect

A prompt adds no model messages by itself: the decision replaces the interactive approval card, and an answered question is one tool result like any other. Expiry and cancellation settle through the harness's own rejection and cancellation records.

#### KV Cache effect

Waiting does not rewrite history. The session pauses on the pending tool call or question and resumes with the decision appended, so the prefix stays warm across the wait.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Guild channels need a privileged portal toggle** — the package identifies with `GUILD_MESSAGES | DIRECT_MESSAGES` only, so guild-channel bodies arrive empty until Message Content intent is enabled for the application in the Discord developer portal. Direct messages are exempt and arrive complete.
- **One Host per bot token** — two processes identifying with the same token both receive every event and both reply; run the gateway in exactly one process.
- **Text and approval reactions only** — attachments and embeds are ignored; inbound reactions matter only while an approval waits in that channel, and long inbound text is truncated at `maxInputChars` rather than split across turns.
- **No receipt or failure notice in Discord** — the typing indicator covers a running turn, but the gateway sends no acknowledgement on arrival and no channel message when a turn times out or fails; those outcomes appear only in the Host log.
- **Idle command answers are not logged** — `/new`, `/status`, and `/stop` answered while no conversation is live reply from durable state with no agent to record them, so those exchanges never enter a session log.
- **Proactive delivery is best-effort text** — if the post of a settled proactive turn fails, that text is dropped rather than retried, and only the final assistant text travels; intermediate narration stays in the session.
- **Questions need text answers** — option numbers are parsed from chat text, so with `answerers: [reaction]` an approval can still be answered by reaction but a question can only expire.
- **Prompt ids are best-effort** — a reaction is accepted only when the prompt post returned its message id; if Discord's response carries none, that approval is answerable by text reply only.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`gateway.ts` owns the websocket lifecycle (identify, heartbeat, resume, reconnect backoff), reports status through `onStatus`, and hands the bot's own user id from each `READY` to the router for mention checks. `conversation.ts` owns conversation open/resume/release through `openUnattendedSession` and `resumeUnattendedSession`, per-channel serialization through a tail promise, debouncing, delivery, and the `agent/status` idle listener that carries settled proactive turns to the channel; `turn-stopping` fires before the final assistant text commits, which is why delivery rides the idle transition instead. Slash commands bypass the serial tail so `/stop` reaches a running turn; `commands.ts` registers `/new`, `/status`, and `/stop` into each conversation Agent's scope, and the router answers them from durable state when no agent is live. `answerers.ts` holds the approval and question prompt text plus reply matching; `conversation.ts` keeps one waiting request per channel in a pendings map fed by both message text and `MESSAGE_REACTION_ADD` events, and a reaction only settles an approval when it targets the prompt message id returned by the post. `domain.ts` declares the storage-domain record (`discord_gateway`). Outbound posts reuse `sendDiscordMessage` from `@deepseek-ai/dsh-tool-discord`, so the 2000-character chunking and mention rewriting live in one place. Tests drive both halves with a fake socket, a fake agent, and an in-memory table; no test opens a real Discord connection.

</details>

**Runtime invariant:** No companion is published. The websocket, timers, per-channel sessions, and the open storage domain belong to the plugin fiber and are closed when it stops; `tests/index.spec.ts` covers connect, disconnect, and teardown.
