# Signal messages

English | [中文](signal.zh.md)

The [Signal definition](../../packages/signal/signal/README.md) declares durable outbound messages, provider health, and inbound data messages. The [signal-cli provider](../../packages/signal/signal-cli/README.md) talks to a local signal-cli HTTP daemon through a durable outbox and its event stream. The [notice consumer](../../packages/signal/signal-notices/README.md) claims camera, health, and scheduled-run notices whose target names a Signal destination. Target strings follow the [delivery-target](../../packages/util/delivery-target/README.md) grammar.

## Delivery targets

Every notice producer stores one target string and validates it at load: a Discord channel id, bare or as `discord:<id>`, `signal:group:<base64 id>` for a group, or `signal:number:<E.164>` for one account. A Signal group id is the standard base64 of 32 bytes, so it may contain `+`, `/`, and `=`, which pass through YAML, storage, and the JSON-RPC request unchanged. `camera/notice`, `health/transition`, and `cron/run-finished` are serial events, and each delivery owner returns `true` only for its own transport's targets: the Discord gateway for Discord targets, the notice consumer for Signal targets. A notice nobody claims is retried by its producer, and scheduled-run approvals are asked only in Discord.

## Outbox and inbound messages

`ctx.signal.send` returns after the message is stored under its delivery id, so a producer that repeats a handoff with the same id is answered `duplicate` instead of sending twice. The provider splits long text into Signal-sized parts, sends them in order per target with a durable part checkpoint, retries failures with a doubling delay, and abandons a delivery after a permanent daemon error or its attempt limit, keeping a receipt with the reason. A stored image is read at send time and attached to the first part. Inbound data messages arrive as `signal/message` with the sender, group, text, timestamp, and attachment metadata; no consumer turns them into a conversation yet.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsignal--signalservice-abstract-seam"></a>

### `ctx.signal` — `SignalService` (abstract seam)

Provider-neutral Signal capability; one provider owns `ctx.signal`.

```ts cordis-catalog
/**
 * Accept one outbound message durably; transmission and its retries happen afterwards.
 * @param request - delivery id, destination, text, and optional stored image.
 * @returns the delivery id and whether it was newly queued or already accepted.
 * @throws Error when the message is empty, too long, or the queue is full or stopping.
 */
abstract send(request: SignalSendRequest): Promise<SignalDeliveryResult>

/**
 * Check the transport now and report the outbound queue.
 * @returns reachability, masked account, and pending deliveries.
 */
abstract health(): Promise<SignalHealth>
```

Source: [`packages/signal/signal/src/index.ts`](../../packages/signal/signal/src/index.ts)

<a id="signal-events"></a>

### `signal/*` events

<a id="signalmessage--parallel"></a>

#### `signal/message` — parallel

One inbound data message from another account. Listeners should enqueue work and return; the provider awaits every listener before the next message and logs failures without retrying.

```ts cordis-catalog
/**
 * One inbound data message from another account. Listeners should enqueue work and return; the
 * provider awaits every listener before the next message and logs failures without retrying.
 * @param message - sender, group, text, timestamp, and attachment metadata.
 * @mode parallel
 */
'signal/message'(message: SignalInboundMessage): void | Promise<void>
```

Source: [`packages/signal/signal/src/index.ts`](../../packages/signal/signal/src/index.ts)
<!-- END GENERATED cordis-surface -->
