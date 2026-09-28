---
description: "Delivery target grammar for notice producers and gateways: Discord channel ids and Signal group or number targets."
kind: "package-library"
---

# dsh-delivery-target

English | [中文](README.zh.md)

## Summary

One grammar for where a notice goes. Producers store a target string and validate it at load with `assertDeliveryTarget`; each delivery owner claims only its own transport's targets with `discordChannelOf` or `signalTargetOf`, so the Discord gateway and the Signal consumer never compete for a notice. A bare Discord channel id keeps working unchanged.

## Table of Contents

- [Use this package](#use-this-package)
- [API](#api)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

It is a **library, not a service or plugin**: no `ctx`, registers nothing, holds no state. No runtime invariant companion is published because it owns no event stream or mutable runtime data.

| Target | Transport |
|---|---|
| `123456789012345678` or `discord:123456789012345678` | Discord channel, 17 to 20 digits |
| `signal:group:<base64 group id>` | Signal group; the id is standard base64 of exactly 32 bytes, with `+`, `/`, and `=` padding kept as written |
| `signal:number:<E.164 number>` | One Signal account, such as `signal:number:+15551234567` |

Any other string is invalid. Validate at the configuration or tool boundary so the error names the field; a delivery owner that meets an invalid stored target leaves the notice unclaimed.

-----

<a id="api"></a>
## API

```ts
import { assertDeliveryTarget, discordChannelOf, signalTargetOf } from '@deepseek-ai/dsh-delivery-target'
```

| Export | Role |
|---|---|
| `parseDeliveryTarget(value)` | Parsed Discord or Signal target, or `undefined` |
| `assertDeliveryTarget(value, field)` | Parsed target; throws `<field> must be <accepted forms>` otherwise |
| `DELIVERY_TARGET_FORMS` | The accepted forms, worded for errors |
| `discordChannelOf(value)` | Discord channel id of a Discord target, else `undefined` |
| `signalTargetOf(value)` | Signal group or number target, else `undefined` |
| `formatSignalTarget(target)` | The target string for a Signal target |
| `parseSignalGroupId(value)`, `parseSignalNumber(value)` | Branded `SignalGroupId` or `SignalNumber`, or `undefined` |

-----

<a id="model-experience"></a>
## Model Experience

### Delivery targets

#### What the model sees

The library registers no tool, schema, or prompt. The cron tool's validation error quotes `DELIVERY_TARGET_FORMS` when the model supplies an unusable `deliver_channel`.

#### Token effect

The error adds one sentence to that failed tool result only.

#### KV Cache effect

The error is appended as a tool result and leaves earlier request content unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Group ids only as base64** — a Signal group cannot be named by its display name, because names are neither unique nor stable.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
