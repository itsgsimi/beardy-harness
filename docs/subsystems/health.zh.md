# 端点健康状态

[English](health.md) | 中文

[health 包](../../packages/health/health/README.zh.md)只检查显式配置的 HTTP 端点。本参考说明进程内探针状态、cron 失败观测以及向 Discord gateway 交接状态转换的方式。

## 状态与交付

每个探针从 `unknown` 开始。连续失败次数达到 `failureThreshold` 后，未知或健康状态变为 `down`；连续成功次数达到 `recoveryThreshold` 后，故障状态变为 `healthy`。初次成功会变为健康状态，但不发送通知。快照包含名称、状态、上次检查时间和有界失败原因，不包含 URL、响应正文或凭据。

配置通知频道后，health owner 通过 `health/transition` 发送每次故障或恢复转换，并附带稳定标识。gateway 将通知写入现有持久化 outbox 后才确认事件。写入失败时，重试沿用同一标识，端点探测仍会继续。网关恢复接收后，待处理的转换依次进入 outbox。冷却期抑制同一探针同类转换的重复通知。进程重启时，探针状态重置为未知。

health owner 在 gateway 接收投递前观测 `cron/run-finished`，并保留最近一次失败、超时或中断的结果：任务名称、Session id、代码和可选的下次触发时间。`ctx.healthStatus` 通过只读快照向 gateway 的 `/status` 回复提供该事实。cron 注册表负责持久的逐任务历史与 `/cron status`。

```ts type-equiv
/** One probe's current process-local observation. */
interface ProbeSnapshot {
  /** Configured probe label. */
  readonly name: string
  /** Current state since this Host mount. */
  readonly state: 'unknown' | 'healthy' | 'down'
  /** Epoch milliseconds of the latest completed HTTP check. */
  readonly checkedAt?: number
  /** Bounded status or failure class, absent after success. */
  readonly cause?: string
}
```

```ts type-equiv
/** Most recent failed cron outcome observed by the gateway. */
interface CronFailureSnapshot {
  /** Name of the failed scheduled job. */
  readonly jobName: string
  /** Reserved Session identity of that run. */
  readonly sessionId: string
  /** Failure code or terminal outcome when no classified failure exists. */
  readonly code: string
  /** Next armed UTC fire when the scheduler has one. */
  readonly nextFireAt?: string
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxhealthstatus--healthstatus"></a>

### `ctx.healthStatus` — `HealthStatus`

Read-only status of process-local probes and the latest failed cron outcome.

```ts cordis-catalog
/**
 * Read bounded process-local status for human commands.
 * @returns current probe observations and the most recent failed cron fact, if any.
 */
snapshot(): { probes: readonly ProbeSnapshot[]; lastCronFailure?: CronFailureSnapshot }
```

Source: [`packages/health/health/src/index.ts`](../../packages/health/health/src/index.ts)

<a id="health-events"></a>

### `health/*` events

<a id="healthtransition--serial"></a>

#### `health/transition` — serial

One probe state transition awaiting durable Discord outbox acceptance.

```ts cordis-catalog
/**
 * One probe state transition awaiting durable Discord outbox acceptance.
 * @param transition - Stable identity, destination, and non-secret text.
 * @returns true after durable acceptance, or undefined when no gateway owns delivery.
 * @mode serial
 */
'health/transition'(transition: { id: string; channelId: string; text: string }): true | undefined | Promise<true | undefined>
```

Source: [`packages/health/health/src/index.ts`](../../packages/health/health/src/index.ts)
<!-- END GENERATED cordis-surface -->
