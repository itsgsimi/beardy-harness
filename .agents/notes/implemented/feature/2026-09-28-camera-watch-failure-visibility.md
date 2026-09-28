# Agent Note: Camera watch reports a broken classifier

Status: implemented

English | [中文](2026-09-28-camera-watch-failure-visibility.zh.md)

## Problem

The camera watch resolves its model route lazily, at each event, because providers register after the watch applies. On 2026-09-28 the configured route could not be resolved from 04:07 to 07:51: the pi-ai adapter refused a model whose `reasoningEfforts` declared only `off`. Every event failed classification with `MODEL_UNAVAILABLE`, and a motion event whose classification fails has no notice reason, so nothing was posted for about four hours and nothing but an error log line per event showed the fault.

## Decision

**Check the route when its provider registers.** The watch resolves the route exactly as an event does, including the image-input check, at start when the route's provider is already registered and on each `llm/adapters-updated` in which that provider has just appeared. The provider is the `modelSelection` provider, or the host default model's provider at that moment. Success logs `camera-watch: classifying with <provider>/<model>`; failure logs an error starting `camera-watch: model route check failed:` with the cause chain and raises a failure notice. The check never throws, so a broken route cannot stop the host, and per-event resolution is unchanged. The pi-ai adapter registers its routes and then refuses to resolve the misconfigured model, so the registry reports the provider in exactly the incident's case.

**Post a rate-limited failure notice through `camera/notice`.** A route failure (`MODEL_UNAVAILABLE`, `MODEL_NOT_VISION`), from the check or an event, raises a notice at once; `TIMEOUT`, `TURN_FAILED`, `NO_ANSWER`, and `SESSION_FAILED` raise one after `failureNoticeThreshold` turns in a row (default 3), and any answered classification ends the run. At most one failure notice is raised per `failureNoticeIntervalMs` (default six hours). The text is `⚠️ Camera classification is failing (<code>: <cause>). Motion alerts are paused; doorbell presses still post.`, with the innermost error's first line, bounded to 200 characters, as a route failure's cause, and the doorbell clause only while `policy.ding` is on. The first answered classification after a failure notice posts `Camera classification recovered.` Both are logged, and handed to `deliverChannelId` when one is configured.

**Stable ids instead of persisted state.** The failure notice id names the `failureNoticeIntervalMs` window, aligned to the Unix epoch, that contains it: `camera-watch:classification-failing:<window start>`; the recovery line appends `:recovered`. The Discord outbox ignores an id it already holds, so a restart inside one window cannot post the same notice twice. The interval, the failure run, and the pending recovery line stay in memory.

## Alternatives considered

**Validate the route at load again.** Providers register after the watch applies, so a load-time check fails a correct deployment on load order, which is why resolution moved to each event.

**Wait for a host-ready event.** The Loader and app boot publish no "all plugins applied" event, and a provider can register later still, after its settings load; the registry's own change event is the moment the route becomes resolvable.

**Persist the failure state in the history domain.** It would keep the interval and the pending recovery line across restarts, but adds a table and a domain version to history for a rate limit whose worst case is one repeated notice or one missing recovery line.

**Notify every failed motion event.** It turns an outage into one message per motion alert for hours.

## Consequences

A misconfigured route is reported at startup, once its provider registers, and again by the first event that meets it, each within one notice interval. A restart that crosses a window boundary can repeat one failure notice, and a failure noticed before a restart gets no recovery line. A provider that never registers is never checked; only events report it. A route edit that keeps the provider registered is not rechecked until an event resolves it.

The watch tests pin the check at start and after a late registration, its failure log and notice, one notice per interval across repeated route failures, the turn-failure threshold and its reset, one recovery line, log-only operation without a channel, and the bounds of the two configuration fields. The `camera-watch` session snapshot is unchanged because its replay route resolves.
