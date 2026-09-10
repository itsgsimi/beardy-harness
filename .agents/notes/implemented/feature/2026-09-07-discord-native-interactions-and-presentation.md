# Agent Note: Native Discord interactions and durable message presentation

Status: implemented

English | [中文](2026-09-07-discord-native-interactions-and-presentation.zh.md)

## Problem

Discord application commands survive the runtime that registered them. A bot that accepts only slash-prefixed chat text leaves another runtime’s menu visible but cannot answer its interactions. Plain command responses and approval prompts also hide the conversation controls Discord users expect, while splitting raw text can break fenced code and leave Markdown tables unreadable.

## Decision

The gateway owns the application’s global command catalog when `nativeCommands` is enabled. It derives commands from the configured preset’s standing registry, adds `/help`, `/new`, `/status`, and `/stop`, and excludes commands whose execution belongs to another UI. On each fresh Gateway READY and after registry changes, it compares the global catalog with the configured commands and bulk replaces it only when different. Guild-specific registrations remain separately managed. Native and text commands share execution, permissions, and conversation lifecycle; publishing a menu does not create an Agent or Session.

Native invocations validate the application, user, and channel, acknowledge before executing work, and return private results. Interaction ids have bounded replay retention; response tokens remain in memory and never enter the durable outbox. Approval buttons and choice menus also match the pending request identity and prompt message. Settlement removes controls; stale or repeated clicks cannot answer a later request. Questions exceeding Discord’s 25-choice limit and free-form questions retain text answers.

The [shared Discord formatter](../../../../packages/discord/tool-discord/README.md) preserves native Markdown and uses maintained mdast GFM parsing to identify tables and code. Tables become labeled bullet groups; oversized fenced code closes and reopens with its language and indentation intact, counting wrapper text against Discord’s UTF-16 limit. Command and lifecycle cards are pure projections of existing results. Status reactions and typing indicate activity without streaming internal reasoning or tool traces.

Storage domain version 3 accepts bounded rich message bodies alongside legacy string chunks. The domain’s default single-file layout rejects older unit versions; `compatibleVersions` applies only to per-record storage and cannot upgrade this file. An operator must stop the gateway, validate every stored record with the current schemas, preserve a byte-for-byte backup, and atomically change only the unit version to 3 before reopening. Invalid records prevent that upgrade. The [durable delivery owner](2026-09-07-durable-personal-agent-delivery.md) persists each complete delivery before sending and checkpoints accepted chunks; retries send the saved bodies unchanged. Validation covers total embed text, component rows, choice counts, and unique component identities. Native response tokens and pending waits are transient because they cannot support the same restart guarantee.

The reviewed [Hermes Discord adapter](https://github.com/NousResearch/hermes-agent/blob/79445a496c86a19332ad786494b8384d2167e2d0/plugins/platforms/discord/adapter.py) provides the useful precedent: native commands delegate to shared execution, tables use labeled rows, and prompt controls validate their responder and lifetime. DSH uses its own registry, scoped request waterfalls, and persistent delivery records. [Conversation continuity](2026-09-05-discord-durable-conversations.md) and [approval lifecycle ownership](2026-09-05-discord-approval-answerers.md) remain independently owned; this decision replaces their text-only presentation assumptions.

Preset inheritance and deployment layering remain governed by [Beardy composition layers](2026-09-05-beardy-composition-layers.md); the Discord persona uses concise Markdown and leaves message splitting to the transport.

## Alternatives considered

Clearing obsolete commands without handling native interactions leaves users dependent on undiscoverable text commands. Registering a second set of command handlers would duplicate permission and cancellation behavior, so the native adapter delegates to the existing registry path.

A handwritten Markdown parser would duplicate syntax already handled by maintained dependencies in the repository. A renderer that strips all Markdown would discard useful links and code; the formatter transforms only unsupported tables and boundaries of oversized code blocks.

Reconstructing rich output during delivery retries could change queued text or controls after an upgrade. Persisting complete formatted bodies makes retry behavior independent of the current renderer while retaining the existing at-least-once delivery limit.

## Consequences

One runtime must own a bot’s command catalog and Gateway connection. Discord must deliver interactions through the Gateway rather than a configured outgoing Interactions Endpoint URL. Formatting changes require parser, protocol-limit, and persistence tests; native command and prompt changes require authorization, expiry, replay, and cancellation coverage. Recorded-session snapshots exercise DM replies and native controls through shipped profiles without Discord credentials. Configurable queue, retry, response, and concurrency bounds prevent one conversation from creating unbounded delivery work.
