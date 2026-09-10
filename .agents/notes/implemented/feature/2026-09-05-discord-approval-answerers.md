# Agent Note: Discord approval and question answerers over reactions and replies

Status: implemented

English | [中文](2026-09-05-discord-approval-answerers.zh.md)

## Problem

An agent working from Discord stopped dead the moment a tool needed permission or it asked the user a question: both ride waterfalls (`approval/request`, `user-questions/request`) whose only composed answerer renders a Web UI, and a person in a Discord channel never sees that card. The turn held its pending tool call open until its timeout while the human — holding the very device the conversation lives on — had no way to answer. A gateway that cannot ask permission is a gateway that must run `danger-full-access`, which is exactly the pairing this deployment refuses.

## Decision

The router composes itself as a second listener on both waterfalls and turns each request into one channel prompt. Native controls follow the [interaction presentation decision](2026-09-07-discord-native-interactions-and-presentation.md). For approvals it posts "Approval needed — tool: reason" naming the emoji (✅ allow once, ❌ reject) and the text words (`yes` / `no`), then waits; a reaction settles only when it comes from an allowlisted user and targets the message id the prompt post returned, and a text line settles only on an exact `yes`/`no`. For questions it posts one question at a time — heading, detail, numbered options, and a hint naming the accepted reply form — and parses each answer line against that question (`1,3` for multi-select, free text when there are no options), keeping the request waiting on an unparseable reply instead of guessing. The pending entry lives in a per-channel map consulted before the command and debounce paths, so an answer never starts a turn; `answerers` (subset of `component`, `reaction`, `text`) gates which forms count, `approvalTimeoutMs` / `questionTimeoutMs` expire waits with a notice posted to the channel, `/stop` settles what waits, and a newer request on the same channel cancels the older one. Approval outcomes map straight onto the contract (`allowed-once` / `rejected`, `cancelled` for every non-answer path); questions reject with `UserQuestionError` codes `ASK_TIMEOUT`, `ASK_ABORTED`, or `ASK_UNAVAILABLE`. Prompt delivery through the Discord transport is a router seam so tests never dial out; when delivery fails the approval answers `unavailable` — honest reporting, never a silent deny.

## Alternatives considered

Polling the Session for pending approvals and rendering synthetic cards was rejected: both capabilities already publish waterfall answer points designed exactly for alternate surfaces, and composing a listener is that seam's intended use rather than a bypass around it.

Requiring reply-threaded text for every answer was rejected: ordinary answer lines work within the current channel, while reactions retain exact prompt-message matching.

First-request-wins (queue approvals behind the waiting one) was rejected for last-request-wins: an agent that hits a second gated tool while the first prompt still waits has moved on, and the stale prompt would otherwise hold the channel hostage to a decision nobody wants anymore. The cancellation is visible because the older entry settles as `cancelled` through the contract.

Settling approvals from any emoji on any message was rejected: reactions are ambient in a shared guild channel, so both the author allowlist and the exact prompt-message match are required before an emoji becomes a permission grant.

## Consequences

The gateway now listens on `approval/request` and `user-questions/request` for its own agents only — anything else delegates through `next()` untouched — and identifies with two more Discord intents (`GUILD_MESSAGE_REACTIONS`, `DM_MESSAGE_REACTIONS`), which need no portal toggle. A deployment that sets `answerers: [reaction]` can still answer approvals but has no way to answer questions, since option numbers are parsed from text; the README says so. Text answers swallow the matching line for pending requests: a person who types `yes` as small talk while a prompt waits has effectively voted, which is the accepted cost of not requiring a command prefix mid-prompt. Every waiting request holds its tool call open until answered, expired, stopped, or superseded, and listener disposal settles all of them so no fiber outlives the plugin. Reaction matching depends on the message-send response carrying its id; when it does not, that approval degrades to text-only rather than refusing reactions globally.
