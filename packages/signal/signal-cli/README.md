---
description: "signal-cli provider for ctx.signal: JSON-RPC sends through a durable outbox and inbound messages from the daemon's event stream."
kind: "package-reference"
---

# @deepseek-ai/dsh-signal-cli

English | [中文](README.zh.md)

## Summary

Send and receive Signal messages through a [signal-cli](https://github.com/AsamK/signal-cli) daemon on the same host. Each accepted message is stored in a durable outbox before it is sent, sent in order per destination, and retried with a doubling delay while the daemon is down. Inbound data messages from the daemon's event stream are published as `signal/message`. The provider never stops the host when the daemon is unreachable.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Register a number with signal-cli once, then run the daemon for that account on loopback, for example `signal-cli -a <number> daemon --http 127.0.0.1:8820`. The daemon has no authentication, so `baseUrl` accepts only `http://127.0.0.1`, `http://localhost`, or `http://[::1]` with a port and no path. A daemon started with `-a` serves one account and needs no `account` in the configuration, so the phone number stays out of the profile.

| Config | Meaning |
|---|---|
| `baseUrl` | Daemon root, such as `http://127.0.0.1:8820`; required |
| `account` | E.164 account sent with every request, only for a daemon serving several accounts |
| `requestTimeoutMs` | Longest wait for one HTTP request (default 15000) |
| `receive` | Subscribe to the event stream and publish `signal/message` (default true) |
| `reconnectDelayMs`, `maxReconnectDelayMs` | Event-stream reconnect delay, doubling from 1000 to 60000 by default |
| `maxMessageChars` | Longest text of one message; longer deliveries are split (default 2000) |
| `outboxMaxPending` | Unfinished deliveries before `send` refuses (default 200) |
| `outboxMaxChars` | Longest text of one delivery (default 20000) |
| `outboxRetryMs`, `outboxMaxRetryMs` | Send retry delay, doubling from 5000 to 600000 by default |
| `outboxMaxAttempts` | Failed attempts before a delivery is abandoned (default 30) |
| `outboxMaxReceipts` | Completed delivery ids kept to recognize a repeated id (default 1000) |

At start the provider checks `GET /api/v1/check` and logs one line:

- `signal-cli: connected as +*********12` at `info`, with the account masked to its last two digits;
- `signal-cli: connected to http://127.0.0.1:8820; the daemon did not report its account` at `info`, when the daemon answers but names no single account;
- `signal-cli: daemon at http://127.0.0.1:8820 is unreachable (<cause>); deliveries stay queued and retry until it answers` at `error`.

With `account` set, `signal-cli: account +*********99 is not registered with the daemon; sends will fail` at `error` reports an account the daemon does not list. A retried send logs `signal-cli: delivery <id> stays queued; retrying in <ms> ms: <cause>` at `warn`, and an abandoned one logs `signal-cli: delivery <id> abandoned after <reason>` at `error`. Daemon error text quoted in these lines has every phone number masked.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`send` splits the text into parts of at most `maxMessageChars`, preferring paragraph, line, and word breaks, and writes one record to the `signal_cli` storage domain's `outbox` table under the delivery id before returning. A repeated id is answered `duplicate` while its record or receipt remains. The outbox sends records in acceptance order; a failed record holds later records to the same target until its retry time, while other targets continue. Each acknowledged part advances a durable cursor, so a retry resumes at the unsent part. The stored image is read through `ctx.attachments` when its part is sent and passed to signal-cli as a `data:<type>;filename=<name>;base64,<bytes>` attachment; an unreadable image or a missing attachment store leaves a text-only message with a warning.

Each part goes out as one JSON-RPC `send` request to `POST /api/v1/rpc` with `groupId` or `recipient`, the text with its `**bold**` markers removed, and `textStyle` ranges in `start:length:BOLD` form. The provider validates each response at the process boundary and does not use JSON-RPC batch requests. A JSON-RPC error with code -32700, -32600, -32601, -32602, or -1, or a send in which every recipient is unregistered, is permanent and abandons the delivery at once; any other failure is retried until `outboxMaxAttempts`. A send with at least one successful recipient counts as delivered. An abandoned delivery keeps a receipt with its reason, and receipts beyond `outboxMaxReceipts` are removed oldest first.

The receiver holds `GET /api/v1/events` open, validates each Server-Sent Event against the envelope fields it reads, and publishes data messages with text or attachments; receipts, typing, sync, and reaction-only envelopes are ignored. An event whose data is either the receive notification's params or the whole notification is accepted. The stream reconnects after an error or its end with a delay that doubles to `maxReconnectDelayMs` and resets when a connection opens. The startup account comes from `listAccounts`, which a single-account daemon may not offer. Disposal aborts requests and the stream, waits for the send in progress, and closes the storage domain. No invariant companion is published because the outbox records are its only state and the storage domain validates them.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Signal subsystem](../../../docs/subsystems/signal.md) — delivery targets, the outbox, and inbound messages.
- [signal-cli JSON-RPC](https://github.com/AsamK/signal-cli/wiki/JSON-RPC-service) — the daemon's methods and HTTP endpoints.

-----

<a id="model-experience"></a>
## Model Experience

### signal-cli provider

#### What the model sees

The provider registers no tool, schema, or prompt, and no consumer shows its `signal/message` payloads to a model in this release.

#### Token effect

The provider adds no model tokens.

#### KV Cache effect

The provider does not alter request caching.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Delivery is at least once: a part the daemon sent but whose checkpoint was not written is sent again after a restart.
- Only `**bold**` is converted to a Signal style; other Markdown in scheduled-run text arrives as literal characters.
- The daemon's error codes are classified from signal-cli's documented codes; a code added later is retried until `outboxMaxAttempts`.
- Inbound attachments are described, not downloaded.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
