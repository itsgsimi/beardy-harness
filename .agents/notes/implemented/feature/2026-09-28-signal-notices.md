# Agent Note: Signal notices through transport-tagged delivery targets

Status: implemented

English | [中文](2026-09-28-signal-notices.zh.md)

## Problem

Goran wants a more private place than Discord for Beardy's camera alerts with their frames, probe health transitions, and scheduled reports, and chose a Signal group. Every notice producer stored a bare Discord channel id, checked it with its own snowflake pattern, and handed it to a serial event that only the Discord gateway answered, so a second transport had nowhere to plug in.

## Decision

A target string now names the transport. `@deepseek-ai/dsh-delivery-target`, a library under `util/`, parses a bare or `discord:`-prefixed channel id of 17 to 20 digits as Discord, `signal:group:<id>` with a canonical standard base64 id of exactly 32 bytes as a Signal group, and `signal:number:<E.164>` as one account. It lives outside the Signal packages so that health, cron, camera-watch, and fantasy-reports validate targets without depending on a messaging capability. Those producers replace their snowflake checks with `assertDeliveryTarget`, whose error names the field and every accepted form; cron also checks configured jobs and the `deliver_channel` tool argument before approval, while jobs stored earlier keep their target. On `camera/notice`, `health/transition`, and `cron/run-finished` the Discord gateway returns `undefined` for anything but a Discord target, so the next serial listener can claim it, and a cron run delivering to Signal gets no Discord approval prompt. `cronDeliveryContent` moved from the gateway to `dsh-cron` so both transports post the same text.

Signal is a seam of three packages. `@deepseek-ai/dsh-signal` defines `ctx.signal` with `send`, which resolves once the message is stored under its delivery id, `health`, and the parallel `signal/message` event for inbound data messages. `@deepseek-ai/dsh-signal-cli` implements it against a signal-cli 0.14.8 daemon on loopback: JSON-RPC `send` over `POST /api/v1/rpc`, the liveness check, and the Server-Sent Events stream at `/api/v1/events` parsed with `eventsource-parser` and validated with zod at the process boundary. Its outbox reuses the Discord gateway's storage-domain shape (persist before send, per-target order, part cursor, doubling retry, bounded receipts) and adds abandonment after a permanent JSON-RPC error or `outboxMaxAttempts`, because a wrong group id would otherwise block its target forever. The daemon runs with `-a <number>`, so the profile needs no `account`; the provider logs the account from `listAccounts` masked to its last two digits and masks numbers quoted in daemon errors. `@deepseek-ai/dsh-signal-notices` is a separate consumer so the provider depends on no producer package and a later provider reuses it.

## Alternatives considered

**Keep bare ids and add a `transport` field per producer.** Four producers and the stored cron records would each need a second field and a migration; one tagged string keeps existing values valid.

**Put the target parser in the Signal definition.** Producers would depend on a messaging capability they do not use.

**Send every part of a delivery in one JSON-RPC batch.** The daemon's processing order for batch members is not documented, and a partial failure would need per-member checkpoints; single requests keep the part cursor exact.

**Retry permanent errors forever, as the Discord outbox does.** A misconfigured group would hold every later notice to it.

## Consequences

Inbound messages are published but no consumer answers them; group chat with Beardy needs a transport-neutral conversation core extracted from the Discord gateway first. Only `**bold**` becomes a Signal text style; other Markdown in scheduled-run text arrives literally. Delivery is at least once, as with Discord. A stored cron job with an unparseable target, accepted before validation, is no longer claimed by the Discord gateway and stays pending in cron's handoff. Tests run a fake daemon on an ephemeral loopback port and never contact signal-cli or Signal.
