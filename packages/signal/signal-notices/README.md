---
description: "Delivers camera notices, health transitions, and scheduled-run outcomes whose target is a Signal group or number through ctx.signal."
kind: "package-reference"
---

# @deepseek-ai/dsh-signal-notices

English | [中文](README.zh.md)

## Summary

Send Beardy's notices to Signal by pointing a producer at a Signal target. The consumer claims every `camera/notice`, `health/transition`, and `cron/run-finished` whose target is `signal:group:<base64 id>` or `signal:number:<E.164>`, queues the same text the Discord path posts through `ctx.signal`, and leaves Discord targets to the Discord gateway.

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

Mount it beside a Signal provider such as [signal-cli](../signal-cli/README.md); it takes no configuration. Then set a producer's target to a Signal destination: `deliverChannelId` of [camera-watch](../../camera/camera-watch/README.md), `noticeChannelId` of [health](../../health/health/README.md), a team's `channelId` or `shadowChannelId` of [fantasy-reports](../../fantasy/fantasy-reports/README.md), or a job's `deliverChannel` of [cron](../../cron/cron/README.md). Quote the value in YAML for readability; standard base64 characters `+`, `/`, and `=` pass through unchanged either way.

```yaml
- id: signal-cli
  name: '@deepseek-ai/dsh-signal-cli'
  config:
    baseUrl: http://127.0.0.1:8820
- id: signal-notices
  name: '@deepseek-ai/dsh-signal-notices'
- id: camera-watch
  name: '@deepseek-ai/dsh-camera-watch'
  config:
    deliverChannelId: 'signal:group:1QtO3Hub7LE5w2ErIhBrS+WLYdHawvpk03PJMnYREh8='
```

A notice with a Discord target, a malformed target, or no target is left unclaimed so its own owner takes it. A claimed notice answers `true` once the provider has stored it durably; the provider then owns sending and retrying.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Each listener parses the producer's target with `signalTargetOf` from [delivery-target](../../util/delivery-target/README.md). Camera notices keep their stored frame as the message image. Scheduled runs deliver the text `cronDeliveryContent` from [cron](../../cron/cron/README.md) selects, the same text the Discord gateway posts, under the delivery id `cron:<session id>:<fire time>`; a run with nothing to announce is accepted without a message. Camera and health notices keep their producer's id, so a producer's retry is recognized as a duplicate. The consumer keeps no state, so no invariant companion is published.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Signal subsystem](../../../docs/subsystems/signal.md) — delivery targets, the outbox, and inbound messages.
- [Discord gateway](../../discord/discord-gateway/README.md) — the owner of Discord targets on the same events.

-----

<a id="model-experience"></a>
## Model Experience

### Signal notices

#### What the model sees

The consumer registers no tool, schema, or prompt; `camera/notice`, `health/transition`, and `cron/run-finished` notices leave through Signal after their producer has finished and never enter a model request.

#### Token effect

The consumer adds no model tokens.

#### KV Cache effect

The consumer does not alter request caching.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Approvals asked by a scheduled run whose target is a Signal destination are not routed to Signal; they resolve as unavailable.
- Scheduled-run text keeps its Markdown except `**bold**`, which the provider renders as bold.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
