# Cron

[English](cron.md) | 中文

Cron 为每次开始执行的任务触发创建独立的无人值守 Session。跳过的触发没有 Session。本参考记录结果类型与交付事件；[包 README](../../packages/cron/cron/README.zh.md) 负责说明任务配置、连续性笔记、恢复与交付重试策略。

## 运行结果

调度器提交终态历史与保留的输出后，交付消费者会收到 `CronRunFinished`。`sessionId` 与 `firedAt` 这一对值标识多次交接中的同一次触发。跳过的触发使用没有对应 Session 的结果 id；Session 创建失败时，预留的 Session id 也可能没有对应日志。

已记录轮次的终态决定已开始运行的结果。与前一次运行重叠，或被尚未投递的结果阻挡的触发，会以 `skipped` 和原因写入历史，并进入同一投递路径。失败结果在运行历史和待投递记录中保留错误代码与消息；Discord 只展示安全的代码。失败轮次的部分文本不算回答。

```ts type-equiv
/** How one scheduled fire ended, retained in job history and delivery notices. */
type CronRunOutcome = 'answered' | 'no-text-answer' | 'timed-out' | 'failed' | 'interrupted' | 'skipped'
```

```ts type-equiv
/** What one settled fire reports back to the scheduler. */
interface CronRunResult {
  /** How the fire ended. */
  readonly outcome: CronRunOutcome
  /** Outcome id; a skipped fire has no Session log. */
  readonly sessionId: string
  /** Final assistant text of the run; empty when there was none. */
  readonly text: string
  /** Failure or skip reason; absent when neither applies. */
  readonly failure?: { readonly code: string; readonly message: string }
}
```

```ts type-equiv
/** A settled fire retained until delivery listeners durably accept its outcome. */
interface CronRunFinished extends CronRunResult {
  /** Name of the job whose fire settled. */
  readonly jobName: string
  /** Epoch milliseconds of the scheduled or triggered fire. */
  readonly firedAt: number
  /** Delivery target; the owner of its transport claims it, and absent means no delivery. */
  readonly deliverChannelId?: string
  /** Whether an outcome without answer text should produce a notice. */
  readonly reportOutcome: boolean
  /** Next armed fire, resolved from the current job definition when delivery occurs. */
  readonly nextFireAt?: string
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

One cron fire settled, carrying the text a delivery lane may forward. The scheduler emits it after recording the outcome in the job's history; delivering to a channel belongs to whichever listener owns one. Listeners resolve after durably accepting delivery. A rejected listener leaves the outcome pending for another handoff; listeners must deduplicate by outcome id and fire time.

```ts cordis-catalog
/**
 * One cron fire settled, carrying the text a delivery lane may forward. The scheduler emits it
 * after recording the outcome in the job's history; delivering to a channel belongs to whichever
 * listener owns one.
 * Listeners resolve after durably accepting delivery. A rejected listener leaves the outcome
 * pending for another handoff; listeners must deduplicate by outcome id and fire time.
 * @param payload - Persisted run result, job identity, fire time, and delivery policy.
 * @returns `true` after durable delivery acceptance, or undefined when the listener does not own delivery.
 * @mode serial
 */
'cron/run-finished'(payload: CronRunFinished): true | undefined | Promise<true | undefined>
```

Source: [`packages/cron/cron/src/types.ts`](../../packages/cron/cron/src/types.ts)
<!-- END GENERATED cordis-surface -->
