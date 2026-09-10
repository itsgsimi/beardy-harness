---
description: "Discord conversations with durable sessions, native slash commands, approval buttons, choice menus, Markdown replies, and delivery recovery for users working with a DSH agent from Discord."
kind: "package-reference"
---

# @deepseek-ai/dsh-discord-gateway

English | [中文](README.zh.md)

## Summary

Converse with a DSH agent from an allowlisted Discord account through direct messages or addressed posts in configured guild channels. Each channel keeps a durable session in the configured workspace and presets, resumes after restart or idle release, and appears beside other sessions in the Web UI. Native commands inspect and control the conversation; approval buttons and choice menus answer pending requests in Discord. Replies preserve useful Markdown, and typing plus status reactions show when a turn is running. `enabled: false` mounts the plugin without connecting.

## Table of Contents

- [Conversation behavior](#conversation-behavior)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="conversation-behavior"></a>
## Conversation behavior

- **Durable conversations.** The channel’s session id, preset, and workspace live in a storage-domain record. After restart or idle release (`idleReleaseMs`), the next message resumes that session; after `conversationMaxAgeMs` of silence, the next message starts a fresh session. Idle release waits until the agent is idle and no request is waiting for an answer.
- **Message batching.** Messages that arrive within `inboundDebounceMs` join into one turn so a person typing several short messages is answered once; `0` answers every message on its own.
- **Progress and outcomes.** `typingIndicator` repeats the typing indicator while an inbound turn runs. `reactionStatus` adds 👀 while processing and replaces it with ✅ for a completed turn or ❌ otherwise; reaction failures do not block the conversation. Timeouts and errors post a notice with current-conversation controls.
- **Guild gating.** Guild channels must appear in `allowedChannelIds`, and with `guildRequireMention: true` (the default) only messages that mention the bot or reply to one of its messages are answered. Direct messages from allowed users are always answered.
- **Native and text commands.** The command menu combines the configured preset’s registry with `/help`, `/new`, `/status`, and `/stop`. `/help` lists available commands; `/new` makes the next message start a fresh session; `/status` shows the session, presets, activity, and queued deliveries; `/stop` cancels current work and waiting requests. Native invocations acknowledge promptly and return private results. Slash-prefixed chat text uses the same command execution path. Preset commands require a live conversation and otherwise return guidance; `excludedPresetCommands` defaults to the Web-only `export` command.
- **Message formatting.** Ordinary answers keep headings, bold text, lists, links, and fenced code. Tables become labeled bullet groups, and long code blocks retain their language and indentation across bounded messages. `richMessages` renders command results and lifecycle notices as cards using `accentColor`; their buttons explicitly target the channel’s current conversation. The [shared Discord formatter](../tool-discord/README.md) owns text and mention handling.
- **Proactive delivery and reminder wake.** Settled proactive turns queue their final assistant text for the channel. At startup the gateway inspects only its recorded conversations and resumes each session when its earliest pending reminder is due; idle release re-arms that timer. The session’s `dsh-schedule` dispatches the reminder without another inbound message. Failed reads or resumes retry after `wakeRetryMs`.
- **Cron run delivery.** A finished `dsh-cron` result is acknowledged only after its text enters the durable queue; repeated run ids are suppressed within the retained receipt window. Runs with no text queue an outcome line when `deliverOutcomes` requests one. Delivery recovery never reruns the agent.
- **Bounded delivery recovery.** Final replies and channel notices persist as complete message bodies before posting; each acknowledged chunk checkpoints progress. `outboxMaxPending` bounds pending records and `outboxMaxChars` bounds each delivery’s text or serialized rich bodies. Overflow refuses enqueue and logs a diagnostic. Failed deliveries retry from `outboxRetryMs` up to `outboxMaxRetryMs`; restart continues unacknowledged chunks with their saved formatting.
- **Approvals and questions.** Approval prompts offer **Allow once** and **Reject** buttons; questions with up to 25 choices offer a single or multiple choice menu. `answerers` enables `component`, `reaction`, and `text` by default: approvals also accept ✅ / ❌ or `yes` / `no`, and questions accept option numbers or free text. Component mode retains text answers for free-form questions and menus with more than 25 choices. Controls match the allowlisted user, channel, prompt message, and request identity; answered, expired, or superseded prompts cannot settle another request. Controls are removed after settlement, and waits expire after `approvalTimeoutMs` / `questionTimeoutMs`. One request waits per channel.

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

- **Guild message visibility** — the gateway requests message and reaction intents without the privileged Message Content intent. Discord exposes direct-message and bot-mentioned content; allowing unaddressed guild messages with `guildRequireMention: false` does not make their bodies available.
- **One Host per bot token** — two processes identifying with the same token both receive every event and both reply; run the gateway in exactly one process.
- **One global command catalog** — `nativeCommands` compares this application’s global catalog with the configured commands on each fresh Gateway READY and after preset registry changes, replacing it only when different. Commands from another runtime are removed from that global catalog; guild-specific registrations remain separately managed. Failed syncs retry after `commandSyncRetryMs`. The application must receive interactions through the Gateway, with no outgoing Interactions Endpoint URL configured.
- **Inbound text only** — attachments and embeds are ignored; inbound reactions matter only while an approval waits in that channel. Long inbound text is truncated at `maxInputChars` rather than split across turns.
- **No streamed tool trace** — replies deliver committed assistant output. Status reactions and typing indicate activity; internal reasoning and tool traces are not streamed into the channel.
- **Idle command answers are not logged** — gateway controls answered while no conversation is live use durable state with no agent to record them, so those exchanges do not enter a session log.
- **Stored unit upgrades are explicit** — a version 1/2 single-file unit fails to open under version 3. With the gateway stopped, an operator must validate every conversation and outbox record against the current schemas, preserve a byte-for-byte backup, and atomically update only `unit.version` before reopening. Invalid records stop the upgrade. The [JSON storage backend](../../storage/storage-json/README.md) defines unit-version checks; per-record compatibility does not apply to this domain’s layout.
- **Delivery can duplicate** — a crash after Discord accepts a chunk but before its local checkpoint may resend it. Receipts retain only `outboxMaxReceipts` ids. Native interaction replies and pending approval or question prompts are transient; their response tokens and waits are not restored after restart.
- **Reaction-only questions cannot be answered** — `answerers: [reaction]` can settle approvals, but questions require `text` or `component`.
- **Prompt ids are required for controls** — reactions and native prompt controls require the returned message id. A prompt response without an id leaves only its enabled text answer path.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The command registry owns command descriptions and handlers; `interactions.ts` maps them to Discord’s native catalog and response API, and `native.ts` authorizes and acknowledges invocations before delegating to the router. Interaction tokens stay in memory. Gateway commands register in a command-injected child of each agent and are removed with that agent.

`gateway.ts` owns protocol parsing and connection lifecycle. `conversation.ts` owns session routing, pending requests, and final-reply cursors; `presentation.ts` derives cards and controls without altering session events. `wake.ts` restores reminder timers; `outbox.ts` retains channel-ordered deliveries. Storage domain version 3 validates rich content, embed totals, and component limits, and sends legacy string chunks unchanged. Its default single-file layout requires the unit itself to be stamped version 3; accepting legacy record fields does not upgrade an older unit. Unit tests substitute the transport; recorded-session snapshots exercise shipped-profile DM delivery and native interactions without Discord credentials.

</details>

**Runtime invariant:** No companion is published. The websocket, timers, per-channel sessions, and the open storage domain belong to the plugin fiber and are closed when it stops; `tests/index.spec.ts` covers connect, disconnect, and teardown.
