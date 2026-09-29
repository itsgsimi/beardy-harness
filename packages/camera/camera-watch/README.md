---
description: "Camera watch: one logged tool-free vision-model classification per camera event, a notification policy, Discord notices with a frame, event history, and the camera tool."
kind: "package-reference"
---

# @deepseek-ai/dsh-camera-watch

English | [中文](README.zh.md)

## Summary

Get told about the camera events that matter and stay quiet otherwise. For each doorbell press or motion alert, the watch shows the frames to a vision model in one logged turn, reads a structured verdict, and applies a policy: every doorbell press, a delivered package, a person at night, a vehicle arriving or leaving on chosen cameras, and someone who stays in view. Notices reach a Discord channel with a frame; a doorbell press, or motion whose first frame already notifies, is announced from that frame first. A bounded event history answers the read-only `camera` model tool.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount a camera provider such as [camera-ring](../camera-ring/README.md), an image-capable model route, the attachment store, a storage domain backend, and, for notices, the delivery owner of the target: the [Discord gateway](../../discord/discord-gateway/README.md) for a Discord channel or [signal-notices](../../signal/signal-notices/README.md) for a Signal target. `timezone` is required; `deliverChannelId` enables notices.

| Config | Meaning |
|---|---|
| `timezone` | IANA zone for the night window, notice times, and tool results |
| `modelSelection` | Exact `{ provider, model, reasoningEffort? }`; absent uses the host default model at each event |
| `deliverChannelId` | Notice target: a Discord channel id, `discord:<id>`, `signal:group:<base64 id>`, or `signal:number:<E.164>`; absent keeps history only |
| `workspacePath` | Absolute working directory recorded on classification Sessions |
| `policy.ding`, `policy.packageDelivered`, `policy.nightPerson` | Notify doorbell presses, delivered packages, and people at night (all on by default) |
| `policy.nightStart`, `policy.nightEnd` | Night window as local `HH:MM`, `21:00` to `06:00` by default |
| `policy.personDevices` | Device ids where any person seen notifies at any hour, such as a front door; none by default |
| `policy.vehicleDevices` | Device ids whose vehicle activity notifies |
| `policy.vehicleActivities` | Vehicle activities that notify on those devices: `arriving` and `leaving` by default; `passing` and `parked` can be added |
| `policy.lingerSeconds` | Time between the first and last frame showing a person that counts as lingering, 20 by default |
| `policy.minConfidence` | Lowest verdict confidence that can notify beyond a doorbell press, 0.5 by default |
| `policy.arrivalBaselineMs` | Oldest earlier event on the same `vehicleDevices` camera whose vehicle count an event is compared with, 12 hours by default (0 turns the comparison off, at most seven days) |
| `immediateDingNotice` | Post a doorbell press notice with the first frame before classification, then the classified notice as a follow-up; on by default |
| `earlyMotionNotice` | Classify a motion event's first frame alone and post a notice at once when it already notifies; the full classification then posts an update only when it adds something; on by default, one extra classification per motion event while a channel is configured |
| `maxOutputTokens`, `turnTimeoutMs` | Classification output ceiling and time bound |
| `maxConcurrent`, `maxQueued` | Classifications at once, first-frame checks included, and events waiting beyond them |
| `retentionDays`, `maxHistory`, `sweepIntervalMs` | Age and count bounds for history records and their stored frames, and the pause between retention sweeps, from one minute to one day |
| `deliveryAttempts`, `deliveryRetryMs` | Handoff attempts for one notice and the delay between them |
| `failureNoticeThreshold`, `failureNoticeIntervalMs` | Classification turns in a row that fail before a failure notice, 3 by default (1 to 100), and the least time between two failure notices, six hours by default (one minute to seven days) |
| `tool`, `toolMaxEvents` | Register the `camera` tool and bound one result |

A `policy.personDevices` or `policy.vehicleDevices` entry that names no provider device and an empty `policy.vehicleActivities` list fail at load. The model route is not checked at load, because providers register after the watch. When the route's provider registers, the watch resolves the route once, including the image-input check, and logs `camera-watch: classifying with <provider>/<model>`, or an error starting `camera-watch: model route check failed:` with the cause chain; a failed check leaves the host running. Each event still resolves the route: one that cannot be resolved records the event with `MODEL_UNAVAILABLE`, and one that declares no image input records it with `MODEL_NOT_VISION`; a doorbell press still notifies.

A failed route check, an event recorded with `MODEL_UNAVAILABLE` or `MODEL_NOT_VISION`, or `failureNoticeThreshold` classification turns in a row ending with `TIMEOUT`, `TURN_FAILED`, `NO_ANSWER`, or `SESSION_FAILED` posts one failure notice to `deliverChannelId`, at most once per `failureNoticeIntervalMs`: `⚠️ Camera classification is failing (<code>: <cause>). Motion alerts are paused; doorbell presses still post.` The cause is the innermost error's first line for a route failure and the run length for turn failures; while `policy.ding` is off the notice ends after `Motion alerts are paused.` The first answered classification after a failure notice posts `Camera classification recovered.` Without `deliverChannelId`, both are only logged, as `camera-watch: classification is failing (<code>: <cause>)` and `camera-watch: classification recovered`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Events queue by id; a repeated id or an unknown device is ignored. Up to `maxConcurrent` classifications run at once, and an event arriving while `maxQueued` others wait is recorded unclassified with `QUEUE_FULL`. An event without frames skips classification with `NO_FRAMES`.

Each classification opens a root Session with no agent preset and allows one model request. Its Agent scope registers the classification prompt as the complete system prompt in the persona prefix section, so the host persona and every other section are left out; suppresses runtime context; drops every tool schema through a `system-prompt/assemble` listener, which also covers tools other plugins register into the Agent's own scope after creation, such as the schedule tools; and denies every tool execution through a scoped tool guard. The prompt reaches the log as the Session's system message and the request header records no tools. Its only other input is one `user/message` whose source kind is `camera`: the prompt text and the frames as image blocks. The settled assistant text is read tolerantly: the first JSON object in the text is used even inside fences or prose; labels accept common synonyms and plurals; counts, activity, vehicle activity, and confidence are validated separately; confidence accepts percentages; a vehicle activity other than `none` adds the `vehicle` label. A reading with every field valid is `parsed`, one with some fields is `partial`, and text with no JSON object is `unparsed` and keeps its first line. Turn failures are recorded as `TIMEOUT`, `TURN_FAILED`, `NO_ANSWER`, `NOT_PERSISTED`, `SESSION_FAILED`, `MODEL_UNAVAILABLE`, or `MODEL_NOT_VISION`.

First-frame checks share the `maxConcurrent` slots. A `camera/preview` for a new motion event queues a check of that frame alone while `earlyMotionNotice` is on and a channel is configured, unless every slot is busy and `maxQueued` events already wait; queued checks start before any queued event, so an event never waits for its own check behind itself. The check is its own logged classification Session whose source summary ends in `(first frame)` and whose instruction says the image is only the first frame. When its verdict yields a reason, the notice `camera:<event id>:early` posts at once with that frame and ends with `From the first picture; an update follows only if the rest shows more.` The lingering reason needs two frames, so it never comes from this check, and the vehicle count comparison below applies only to the full classification. The full classification of the same event waits for this notice to settle. After a delivered early notice, the classified notice `camera:<event id>` posts only when it adds to it: a reason the early notice did not state, or a higher count of any label than the first frame showed; its heading then reads `<time> (update)`. Same reasons with equal or lower counts post nothing, because two answers seldom word one scene alike. History records the early check's Session as `earlySessionId`, its reasons as `earlyReasons` when it answered, and its handoff as `earlyDelivery`; `delivery` stays `none` when no update was needed.

The policy runs in code. A doorbell press always yields `ding`. The other reasons need a `parsed` or `partial` verdict at or above `minConfidence`: `package` needs a package with the `delivering` activity, `night-person` a person inside the night window, `person` a person on a device listed in `personDevices` at any hour, `vehicle` a listed device and a vehicle activity listed in `vehicleActivities`, and `lingering` person frames whose recorded offsets span at least `lingerSeconds`. The model's own `lingering` activity never triggers a notice. Parked vehicles never notify by default, so a driveway camera that always shows the household's cars stays quiet on headlights, insects, or wind; `passing` is off by default because street traffic past a driveway is not an arrival; an `unknown` vehicle activity, including a verdict stored before the field existed, never notifies. On a `vehicleDevices` camera, the full classification's vehicle count is compared with the latest earlier record of the same device inside `arrivalBaselineMs` whose verdict reaches `minConfidence`, and the event's own verdict must reach it too. More vehicles read as `arriving` and fewer as `leaving`, and that movement replaces the model's vehicle activity for the `vehicle` rule and the headline, such as `Vehicle arriving`; equal counts leave the model's activity in place. History keeps the model's verdict and adds `vehicleChange` and `baselineEventId`. The `person` notice reads `Person at <device label>`; when `night-person` also applies, history and the `camera` tool keep both reasons and the notice shows only `Person at night`.

When `immediateDingNotice` and `policy.ding` are on and a channel is configured, a `camera/preview` for a new doorbell press hands the notice `camera:<event id>:ding` with the text `Someone rang the doorbell` and the first frame to `camera/notice` at once. The classified notice for the same event waits until that handoff settles, so it arrives second. The history record is written before the classified delivery. The classified notice carries the device label, local time, reasons, the description or why it is missing, and the counts with confidence; the frame shown is the first person frame, or the first frame, and is left out when the delivered immediate notice already showed it. `camera/notice` is a serial event claimed by the owner of the target's transport: the Discord gateway accepts a Discord target into its outbox, which uploads the verified stored frame with the text, and signal-notices queues a Signal target in the Signal outbox. The watch retries a handoff that no listener accepts and records the classified delivery as `delivered`, `undelivered`, `no-channel`, or `none`, and the immediate notice's outcome as `earlyDelivery` (`delivered` or `undelivered`) when one was attempted. History fields added after the first release are optional or defaulted, so earlier records keep parsing: a stored verdict without a vehicle activity reads as `unknown`. A retention sweep runs at startup and again `sweepIntervalMs` after the previous sweep ends. It deletes each record older than `retentionDays` or beyond `maxHistory` together with the frames that no kept record and no unfinished event cites, through `ctx.attachments.deleteImage`. A record stays while one of its frames fails to delete, so the next sweep retries it; a frame that is already gone counts as deleted. A sweep that removes anything logs the event and frame counts at info level. A notice still waiting in the Discord outbox when its frame is deleted posts its text alone.

The route check runs at start when the route's provider is already registered, and on each `llm/adapters-updated` in which that provider has just appeared: the `modelSelection` provider, or the host default model's provider at that moment. It runs again only after the provider leaves the registry and returns. Failure state is process-local. Any answered classification ends a run of turn failures; `NOT_PERSISTED`, `NO_FRAMES`, `QUEUE_FULL`, and route failures neither extend nor end it. The failure notice id is `camera-watch:classification-failing:<window start>`, where the window is the `failureNoticeIntervalMs` span containing the notice, aligned to the Unix epoch, and the recovery line appends `:recovered`; the Discord outbox ignores an id it already holds, so a restart inside the same window does not post the notice twice. Failure and recovery notices carry no frame, use the event notices' handoff retries, and are not written to history. No invariant companion is published because history is the only durable state, every write goes through the storage domain, and the process-local failure state has no independent observation to diverge from.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Camera subsystem](../../../docs/subsystems/camera.md) — events, verdicts, and the notice handoff.
- [Tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-camera-watch) — the generated `camera` schema.
- [Discord gateway](../../discord/discord-gateway/README.md) — the outbox that delivers notices.

-----

<a id="model-experience"></a>
## Model Experience

### Classification Session

#### What the model sees

A separate root Session per event, and per first-frame check of a motion event, has the fixed system prompt below as its complete system prompt, no runtime context, and no tools. It receives one user message: the instruction below, then the event's frames as images in capture order. The instruction's first line names the alert (`doorbell press` or `motion alert`), the device label, the local date and time, and each frame's offset in whole seconds; a first-frame check instead states that the image is only the first frame, its offset, and that later frames are checked separately.

##### Verbatim system prompt

```markdown
You classify still frames from a home security camera.
The user message states the alert and shows the frames. Reply with exactly the one JSON object it asks for and nothing else.
You have no tools. Describe people only by what is visible and never guess who anyone is.
```


##### Verbatim instruction after the first line

```markdown
Reply with only one JSON object and no other text:
{"labels":[],"counts":{},"activity":"none","vehicleActivity":"none","confidence":0,"description":"","personFrames":[]}

- labels: each of "person", "vehicle", "package", "animal" visible in any frame.
- counts: the most of each label visible at once, for example {"person":1}.
- activity: one of "delivering", "lingering", "passing", "ringing", "none".
- vehicleActivity: "arriving" when a vehicle drives into the driveway or a parking spot, or is stopped there with a door open, its lights on, or a person getting in or out, or is present in later frames but not in earlier ones; "leaving" when a vehicle pulls out or is gone from later frames; "passing" when one drives by without stopping; "parked" only when every vehicle stays still with its doors closed, its lights off, and nobody getting in or out; "none" when no vehicle is visible.
- confidence: how sure you are, from 0 to 1.
- description: one sentence of at most 25 words about what is happening. Do not guess who anyone is.
- personFrames: zero-based indices of the frames that show a person.
```

#### Token effect

Each event costs one request: about 60 system-prompt tokens, about 330 instruction tokens, and one image per frame (three by default), with output capped by `maxOutputTokens`. A first-frame check adds one more request with the same prompts and one image.

#### KV Cache effect

Every classification is a fresh Session, so no prefix is shared between events beyond the system prompt.

### Camera tool

#### What the model sees

One `camera` schema with optional `camera`, `hours`, `limit`, and `notified_only` arguments ([schema](../../../docs/tool-catalog.md#deepseek-aidsh-camera-watch)). The result is JSON text with the time zone, the window, the matching total, and events newest first: id, local time, camera label, kind, description, labels, counts, activity, vehicle activity, confidence, classification status, whether any notice was delivered, and the reasons.

#### Token effect

A result lists at most `limit` events (20 by default, `toolMaxEvents` at most); descriptions are at most 200 characters.

#### KV Cache effect

The schema is stable for a fixed device list; each result extends the caller's tool history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Classification Sessions outlive history** — session persistence has no deletion operation, so each classification Session stays in the session log after its record and frames are deleted, and its images then read as missing. One Session log is small next to its frames, but the logs grow with every classified event ([decision](../../../.agents/notes/implemented/feature/2026-09-27-camera-frame-retention.md)).
- **Unrecorded events keep their frames** — an event dropped from the queue at shutdown, repeating a recorded id, or naming an unknown device is never recorded, so no sweep finds its frames.
- **An announced press can go unrecorded** — when the provider stops between a doorbell preview and its complete event, the immediate notice is posted but no history record or follow-up exists.
- **The watch owns recorded frames** — the sweep deletes an expired record's frames without consulting other `camera/event` listeners, so another consumer that keeps frame references past `retentionDays` finds them missing.
- **Arrival counts need a baseline** — the first event on a vehicle camera inside `arrivalBaselineMs`, such as the first one each morning with the default 12 hours, has nothing to compare with, and a vehicle the model miscounts in either event reads as an arrival or a departure. Two events of one device classified at the same time compare with the record written before both.
- **First-frame notices judge one picture** — the early notice can name a person or vehicle the rest of the event does not confirm; the update adds only new reasons and higher counts and never retracts the early notice.
- **No identities** — verdicts describe people generically; recognizing known faces needs a separate opt-in gallery.
- **Text-only history reads** — the `camera` tool returns descriptions, not the stored frames.
- **Shutdown writes** — a history write that races whole-host shutdown can be lost when the storage facility closes first; plugin reload waits for it.
- **Restarts forget failure state** — the notice interval, the turn-failure run, and a pending recovery line live in memory, so a restart that crosses a notice window boundary can repeat one failure notice, and a failure noticed before a restart gets no recovery line.
- **An absent provider is never checked** — the route check waits for the provider to register; until then only events report the unusable route.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
