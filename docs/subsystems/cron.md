# Cron

English | [中文](cron.zh.md)

Cron runs each started job fire in a separate unattended Session. Skipped fires have no Session. This reference owns its outcome types and delivery event; the [package README](../../packages/cron/cron/README.md) owns job configuration, continuity notes, recovery, and delivery retry policy.

## Run results

Delivery consumers receive `CronRunFinished` after the scheduler commits terminal history and retained output. The pair `sessionId` and `firedAt` identifies one fire across repeated handoffs. A skipped fire uses an outcome id without a Session; a reserved Session id can also lack a log when creation fails.

The logged turn ending determines a started run's outcome. An overlapping fire or one held by undelivered output records `skipped` with a reason and enters the same delivery path. A failed result retains its error code and message in run history and pending delivery; Discord displays only a safe code. Partial text from a failed turn is not an answer.

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
  /** Channel destination; absent means no channel delivery. */
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

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
