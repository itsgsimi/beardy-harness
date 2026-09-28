# Agent Note: Camera capture, vehicle rule, classification Session, and doorbell notices after the first live run

Status: implemented

English | [中文](2026-09-27-camera-live-run-tuning.zh.md)

## Problem

The first live run of the [Ring camera events](2026-09-27-ring-camera-events.md) showed four faults. The wired doorbell and the garage floodlight returned the same cached snapshot again during motion; capture dropped the repeat without a failure and without the stream fallback, so events carried one or two frames instead of three. The garage verdict "three parked vehicles, one sedan idling with headlights" notified because the vehicle rule fired on any `vehicle` label, and the household's cars are always in the driveway. The classification Session carried the host persona and the four schedule tools, which the schedule plugin registers into every root Agent's own scope after creation, where `tools.restrict` does not reach. A doorbell notice waited for every frame and the classification, about forty seconds, while someone stood at the door.

## Decision

**A repeated snapshot is a missing live frame.** `captureFrames` treats a snapshot whose bytes repeat the previous snapshot like a refused or timed-out one: that slot and every later one move to the existing single live stream when `streamFallback` is on. Without the fallback the event reports the new `snapshot-stale` capture failure, so `captureFailure` names the actual cause. Only consecutive repeats are detectable; a first snapshot that is already stale looks fresh.

**Vehicles notify by activity.** The verdict gains a required `vehicleActivity` of `arriving`, `leaving`, `passing`, `parked`, `none`, or `unknown`, separate from the person-oriented `activity`, because one frame set can show a parked car and a courier at once. The instruction asks for it and says lights or a running engine do not count as moving. The parser reads it like `activity`, grades a missing or invalid value `partial`, and adds the `vehicle` label for any value other than `none`. The rule `vehicle` now needs a listed device and a vehicle activity in `policy.vehicleActivities`, validated from `arriving`, `leaving`, `passing`, and `parked`, default `arriving` and `leaving`, and non-empty. `passing` is off by default because street traffic past a driveway is not an arrival. The history schema defaults a missing `vehicleActivity` to `unknown`, which never notifies, so records written before the field keep parsing under domain version 1. Person rules are unchanged.

**The classification Session has its own prompt and no tools, through existing extension points.** Inside `agents.create` setup the watch shadows the persona prefix section with a `complete` classification prompt, as the `dsh-persona` row does, calls `suppressRuntimeContext()`, returns an assembly with no tools from a scoped `system-prompt/assemble` listener, and registers a scoped `tools.guard` that denies every execution. The assembly listener runs after every scope's tool providers, so it also removes tools registered into the Agent's own scope after creation; the guard covers a model that names a tool anyway. The loop logs the rendered prompt as the Session's `system/message` and the empty tool set in `request/header`, so the model input stays reconstructable from the log. The watch now injects `systemPrompt`.

**A doorbell press is announced from its first frame.** The camera Definition gains a parallel `camera/preview` with the event identity and first stored frame, which a provider publishes before it captures the rest; the Ring provider publishes it from its frame sink after the first store. With `immediateDingNotice` (default true), `policy.ding`, and a channel, the watch hands `camera:<id>:ding` with `Someone rang the doorbell` and that frame to `camera/notice` at once. The classified notice keeps the id `camera:<id>`, waits for the first handoff to settle so it posts second, and leaves out its frame when the delivered first notice already showed it. History records the first outcome as optional `earlyDelivery`, and the `camera` tool reports an event as notified when either notice was delivered. Motion keeps one notice.

## Alternatives considered

**Keep counting a repeat once.** It silently shortens every wired-camera event, which is the fault observed.

**Notify vehicles only when the vehicle count changes between frames.** Counts are per verdict, not per frame, and the vision model's counting of partly hidden cars is noisy; asking the model what the vehicles do is one field it already reasons about.

**Fold vehicle movement into `activity`.** A verdict would lose either the person or the vehicle activity whenever both appear.

**Restrict tools with `tools.restrict({ allow: [] })`.** A restriction filters only inherited tools, by design, so Agent-scope tools such as the schedule tools stay visible.

**Add a `tools: 'none'` option to `agents.create`, or teach the schedule plugin to skip camera Sessions.** The first changes the Agent factory for one consumer; the second makes every Agent-scope tool owner learn about every tool-free consumer. The assembly waterfall already owns the final tool list.

**Mount the `dsh-persona` row inside setup.** It registers the same section but adds a dependency and the deployment suffix, which the complete section suppresses anyway.

**Publish the complete event early and a second event later.** Two `camera/event`s for one id break the idempotent history and delivery that consumers key on it.

## Consequences

Front-door and garage events get their configured frame count whenever the live stream works; the stream starts a few seconds after the stale snapshot, so those frames are offset later. Parked cars and passing street traffic no longer notify on `vehicleDevices`; a model answer without `vehicleActivity` notifies no vehicle, and verdicts stored before this change read `unknown`. A classification request is about 60 system-prompt tokens plus the instruction and frames, with no tool schemas. A doorbell press yields two messages; when the provider stops between the preview and the complete event, the first message exists without a history record or follow-up.

The capture tests pin a repeated snapshot moving to the stream, `snapshot-stale` without the fallback, and a refused stream after a repeat. The watch tests pin the complete system prompt, the absence of runtime context and of an Agent-scope tool that is registered on `agent/created`, the guard denying it, parked and arriving vehicles, both ding notices with their frames and outcomes, and a previewed frame surviving a sweep. The `camera-watch` session snapshot pins the classification prompt sidecar, the tool-free header, and both delivered notices.
