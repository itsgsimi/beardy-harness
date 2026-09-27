# Endpoint health

English | [中文](health.zh.md)

The [health package](../../packages/health/health/README.md) checks only explicitly configured HTTP endpoints. This reference owns the process-local probe state, cron failure observation, and transition handoff to the Discord gateway.

## State and delivery

Each probe starts `unknown`. Consecutive failed checks move an unknown or healthy probe to `down` at `failureThreshold`; consecutive successful checks move a down probe to `healthy` at `recoveryThreshold`. Initial success becomes healthy without a notice. The snapshot contains a name, state, last check time, and a bounded failure cause; it contains no URL, response body, or credential.

When a notice channel is configured, the health owner sends each down or recovered transition through `health/transition` with a stable identity. The gateway accepts it into its existing durable outbox before acknowledging the event. A failed acceptance retains the same identity for retry while endpoint checks continue. Pending transitions enter the outbox in order once acceptance resumes. The cooldown suppresses repeated notices of the same kind for one probe. Process restart resets probe state to unknown.

The health owner observes `cron/run-finished` before the gateway accepts delivery and retains the latest failed, timed-out, or interrupted outcome: job name, Session id, code, and optional next fire. `ctx.healthStatus` exposes that fact through a read-only snapshot for the gateway's `/status` reply. The cron registry owns durable per-job history and `/cron status`.

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

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
