# Signal 消息

[English](signal.md) | 中文

[Signal 定义](../../packages/signal/signal/README.zh.md)声明持久外发消息、提供方健康状态和收到的数据消息。[signal-cli 提供方](../../packages/signal/signal-cli/README.zh.md)经持久发件箱和事件流与本地 signal-cli HTTP 守护进程通信。[通知使用方](../../packages/signal/signal-notices/README.zh.md)认领目标为 Signal 目的地的摄像头、健康和定时运行通知。目标字符串遵循 [delivery-target](../../packages/util/delivery-target/README.zh.md) 语法。

## Delivery targets

每个通知生产方保存一个目标字符串，并在加载时校验：Discord 频道 id（裸 id 或 `discord:<id>`）、群组的 `signal:group:<base64 id>`，或单个账户的 `signal:number:<E.164>`。Signal 群组 id 是 32 字节的标准 base64，可能含有 `+`、`/` 和 `=`，它们在 YAML、存储和 JSON-RPC 请求中都原样保留。`camera/notice`、`health/transition` 和 `cron/run-finished` 是串行事件，每个投递方只对自己传输方式的目标返回 `true`：Discord 网关处理 Discord 目标，通知使用方处理 Signal 目标。无人认领的通知由其生产方重试，定时运行的审批只在 Discord 中询问。

## Outbox and inbound messages

`ctx.signal.send` 在消息以投递 id 存储后返回，因此生产方用同一 id 重复交接时得到 `duplicate`，不会重复发送。提供方把长文本拆成适合 Signal 的片段，按目标顺序发送并持久记录片段检查点，以倍增延迟重试失败，在守护进程返回永久错误或达到尝试上限后放弃投递，并保留带原因的回执。已存储的图片在发送时读取，附加到第一个片段。收到的数据消息以 `signal/message` 到达，携带发送方、群组、文本、时间戳和附件元数据；目前还没有使用方把它们变成对话。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
