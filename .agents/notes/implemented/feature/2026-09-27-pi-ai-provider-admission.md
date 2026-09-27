# Agent Note: In-process admission for pi-ai provider routes

Status: implemented

English | [中文](2026-09-27-pi-ai-provider-admission.zh.md)

## Problem

Several in-process subagent sessions can request the same single-slot local model at once. The server queues excess work, while the harness sees each outstanding stream read as provider idle time. A queued request can then exhaust `streamIdleTimeoutMs` before the server begins its response, causing retries that increase the queue.

## Decision

`llm-pi-ai` offers an optional positive safe integer `maxConcurrentRequests` on each provider profile. Omission preserves unlimited dispatch. A route with a cap admits requests in FIFO order across calls through one adapter instance. `queueTimeoutMs` is a separate optional positive finite queue deadline bounded by Node's timer range; it requires a cap. Omission lets a waiter remain queued until admitted or aborted. A queued abort removes the waiter, and every admitted stream holds its slot through success, terminal error, caller abort, idle timeout, or consumer teardown. The stream idle watchdog is constructed after admission, so queue time does not use its budget.

The admission count belongs to the adapter instance and provider route, outside its immutable configuration snapshots. Active calls remain counted after a settings change; queued calls retain the cap and deadline they captured. This coordinates in-process `spawn` children because they share the parent's LLM service. Independent processes do not share the count.

An expired queue wait throws `LlmError` with `ADMISSION_TIMEOUT`, distinct from provider `TIMEOUT`. The code is outside the default retryable set: retrying into a full local queue creates more demand without freeing a slot. A provider can explicitly include it in `retryPolicy.retryableCodes`. Admission waits do not produce a separate log; terminal errors use the existing request failure path.

## Alternatives considered

**Put the queue in `dsh-llm`.** The neutral service does not own a provider's deployment cap or the pi-ai dispatch point. Putting provider-specific admission there would force a policy on other adapters without coordinating their distinct transports.

**Raise `streamIdleTimeoutMs` or server parallelism.** A larger idle budget hides server queue time inside a transport timeout. More server slots consume model context or memory. Neither gives this deployment a bounded client-side queue with caller cancellation.

**Retry admission timeouts by default.** The timed-out attempt has not reached the provider, but an automatic retry rejoins the same saturated queue. Explicit per-route retry policy remains available for deployments with changing capacity.

## Consequences

One adapter instance now has a per-route request queue and active counter. Queue timeouts and aborts remove listeners and timers before the next waiter is considered. The slot is released after stream teardown, so an early consumer return cannot admit a successor while its SDK stream is still closing. Separate processes need their own cap or an external coordinator if they share a server. Unit tests cover FIFO order, settings validation, queued cancellation and timeout, all stream exit paths, and queue wait beyond the idle interval.
