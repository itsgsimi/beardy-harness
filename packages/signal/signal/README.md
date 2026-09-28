---
description: "Signal service definition: durable outbound messages to a group or account, provider health, and inbound data messages."
kind: "package-reference"
---

# @deepseek-ai/dsh-signal

English | [中文](README.zh.md)

## Summary

Use `ctx.signal` to send a message, optionally with one stored image, to a Signal group or account, and to receive other accounts' messages as `signal/message`. `send` resolves once the provider has stored the message durably, so a caller that retries with the same delivery id never queues it twice. The package also brands Signal group ids, phone numbers, service ids, and delivery ids.

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

Mount a provider such as [signal-cli](../signal-cli/README.md), then call `ctx.signal.send({ id, target, text, image })`. `target` is `{ transport: 'signal', kind: 'group', groupId }` or `{ transport: 'signal', kind: 'number', number }`; `signalTargetOf` from [delivery-target](../../util/delivery-target/README.md) parses the `signal:group:<id>` and `signal:number:<E.164>` strings producers store. The result is `{ id, state }`, where `state` is `queued` for a new id and `duplicate` for an id the provider already accepted. Paired `**bold**` markers in `text` become bold text; other Markdown stays literal. `health()` checks the transport now and reports reachability, the account masked to its last two digits when known, and the pending delivery count.

Listen for `signal/message` to act on inbound messages. Each payload names the sender's number, service id, or profile name when shared, the group id for a group message, the text, the sender's timestamp, and attachment metadata; attachment content is not fetched. A listener should queue its work and return, because the provider awaits every listener before the next message and logs a failed listener without retrying it.

| Export | Role |
|---|---|
| `SignalService` | Abstract `ctx.signal` service; `send`, `health`, and the protected `publishMessage` |
| `SignalGroupId`, `SignalNumber` | Validating constructors for a 32-byte base64 group id and an E.164 number |
| `SignalServiceId`, `SignalDeliveryId` | Validating constructors for a UUID service id and a printable delivery id of up to 200 characters |
| `SignalSendRequest`, `SignalDeliveryResult`, `SignalHealth`, `SignalInboundMessage` | Request, result, and event types |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The abstract service owns the `ctx.signal` key and the protected `publishMessage`, which runs every `signal/message` listener in parallel and logs each failure. `SignalGroupId` and `SignalNumber` are the brands of [delivery-target](../../util/delivery-target/README.md), which owns target parsing so producers validate Signal targets without depending on this capability. No invariant companion is published because the definition keeps no state of its own.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Signal subsystem](../../../docs/subsystems/signal.md) — delivery targets, the outbox, and inbound messages.
- [Signal notices](../signal-notices/README.md) — the consumer that delivers camera, health, and scheduled-run notices.

-----

<a id="model-experience"></a>
## Model Experience

### Signal service

#### What the model sees

This definition registers no tool, schema, or prompt, and `signal/message` payloads reach no model in this release.

#### Token effect

The definition adds no model tokens.

#### KV Cache effect

The definition does not alter request caching.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- No consumer turns `signal/message` into a conversation yet; group chat with the agent needs a transport-neutral conversation core first.
- A message carries at most one image.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
