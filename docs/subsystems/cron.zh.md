# Cron

[English](cron.md) | 中文

Cron 为每次接受的任务触发创建独立的无人值守 Session。本参考记录运行结果类型与交付事件；[包 README](../../packages/cron/cron/README.zh.md) 负责说明任务配置、连续性笔记、恢复与交付重试策略。

## 运行结果

调度器提交终态历史与保留的输出后，交付消费者会收到 `CronRunFinished`。`sessionId` 与 `firedAt` 这一对值标识多次交接中的同一次运行。Session 创建失败时，预留的 Session id 可能没有对应日志。

```ts type-equiv
/** How one accepted fire ended, retained in job history and delivery notices. */
type CronRunOutcome = 'answered' | 'no-text-answer' | 'timed-out' | 'failed' | 'interrupted'
```

```ts type-equiv
/** What one settled run reports back to the scheduler. */
interface CronRunResult {
  /** How the run ended. */
  readonly outcome: CronRunOutcome
  /** Reserved Session id; its log may be absent when creation failed. */
  readonly sessionId: string
  /** Final assistant text of the run; empty when there was none. */
  readonly text: string
}
```

```ts type-equiv
/** A settled run retained until delivery listeners durably accept its outcome. */
interface CronRunFinished extends CronRunResult {
  /** Name of the job whose run settled. */
  readonly jobName: string
  /** Epoch milliseconds of the fire that started the run. */
  readonly firedAt: number
  /** Channel destination; absent means no channel delivery. */
  readonly deliverChannelId?: string
  /** Whether an empty answer should produce an outcome notice. */
  readonly reportOutcome: boolean
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="cron-events"></a>

### `cron/*` events

<a id="cronrun-finished--serial"></a>

#### `cron/run-finished` — serial

One cron run settled, carrying the text a delivery lane may forward. The scheduler emits it after recording the run in the job's history; delivering to a channel belongs to whichever listener owns one. Listeners resolve after durably accepting delivery. A rejected listener leaves the outcome pending for another handoff; listeners must deduplicate by Session id and fire time.

```ts cordis-catalog
/**
 * One cron run settled, carrying the text a delivery lane may forward. The scheduler emits it
 * after recording the run in the job's history; delivering to a channel belongs to whichever
 * listener owns one.
 * Listeners resolve after durably accepting delivery. A rejected listener leaves the outcome
 * pending for another handoff; listeners must deduplicate by Session id and fire time.
 * @param payload - Persisted run result, job identity, fire time, and delivery policy.
 * @returns `true` after durable delivery acceptance, or undefined when the listener does not own delivery.
 * @mode serial
 */
'cron/run-finished'(payload: CronRunFinished): true | undefined | Promise<true | undefined>
```

Source: [`packages/cron/cron/src/types.ts`](../../packages/cron/cron/src/types.ts)
<!-- END GENERATED cordis-surface -->
