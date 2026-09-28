---
description: "Signal service definition, the signal-cli daemon provider, and the consumer that delivers camera, health, and scheduled-run notices to Signal."
kind: "package-group"
---

# packages/signal

English | [中文](README.zh.md)

## Summary

Post Beardy's notices to a Signal group or account instead of, or beside, Discord. A local signal-cli daemon sends each message through a durable outbox and streams inbound messages back; the notice consumer claims every camera notice, health transition, and scheduled-run delivery whose target is `signal:group:<id>` or `signal:number:<E.164>`.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [signal](signal/README.md) | Outbound message, health, and inbound message types | `ctx.signal` definition |
| [signal-cli](signal-cli/README.md) | signal-cli HTTP daemon client, durable outbox, and event stream | `ctx.signal` provider |
| [signal-notices](signal-notices/README.md) | Camera, health, and scheduled-run notices with Signal targets | service consumer |

-----

<a id="related-documentation"></a>
## Related documentation

- [Signal subsystem](../../docs/subsystems/signal.md) — delivery targets, the outbox, and inbound messages.
- [Delivery targets](../util/delivery-target/README.md) — the target grammar every notice producer validates.

-----

<a id="dev-note"></a>
## Dev Note

None.
