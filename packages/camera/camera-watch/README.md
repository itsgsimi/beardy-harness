---
description: "Camera watch: one logged tool-free vision-model classification per camera event, a notification policy, Discord notices with a frame, event history, and the camera tool."
kind: "package-reference"
---

# @deepseek-ai/dsh-camera-watch

English | [中文](README.zh.md)

## Summary

Get told about the camera events that matter and stay quiet otherwise. For each doorbell press or motion alert from `ctx.camera`, the watch shows the frames to a vision model in one logged turn, reads a structured verdict, and applies a policy: every doorbell press, a delivered package, a person at night, a vehicle arriving or leaving on chosen cameras, and someone who stays in view. Notices reach a Discord channel with a frame; a doorbell press is announced from its first frame and described after classification. A bounded event history answers the read-only `camera` model tool.

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

Mount a camera provider such as [camera-ring](../camera-ring/README.md), an image-capable model route, the attachment store, a storage domain backend, and, for notices, the [Discord gateway](../../discord/discord-gateway/README.md) with its durable outbox. `timezone` is required; `deliverChannelId` enables notices.

| Config | Meaning |
|---|---|
| `timezone` | IANA zone for the night window, notice times, and tool results |
| `modelSelection` | Exact `{ provider, model, reasoningEffort? }`; absent uses the host default model at each event |
| `deliverChannelId` | Discord channel for notices; absent keeps history only |
| `workspacePath` | Absolute working directory recorded on classification Sessions |
| `policy.ding`, `policy.packageDelivered`, `policy.nightPerson` | Notify doorbell presses, delivered packages, and people at night (all on by default) |
| `policy.nightStart`, `policy.nightEnd` | Night window as local `HH:MM`, `21:00` to `06:00` by default |
| `policy.vehicleDevices` | Device ids whose vehicle activity notifies |
| `policy.vehicleActivities` | Vehicle activities that notify on those devices: `arriving` and `leaving` by default; `passing` and `parked` can be added |
| `policy.lingerSeconds` | Time between the first and last frame showing a person that counts as lingering, 20 by default |
| `policy.minConfidence` | Lowest verdict confidence that can notify beyond a doorbell press, 0.5 by default |
| `immediateDingNotice` | Post a doorbell press notice with the first frame before classification, then the classified notice as a follow-up; on by default |
| `maxOutputTokens`, `turnTimeoutMs` | Classification output ceiling and time bound |
| `maxConcurrent`, `maxQueued` | Classifications at once and events waiting beyond them |
| `retentionDays`, `maxHistory`, `sweepIntervalMs` | Age and count bounds for history records and their stored frames, and the pause between retention sweeps, from one minute to one day |
| `deliveryAttempts`, `deliveryRetryMs` | Handoff attempts for one notice and the delay between them |
| `tool`, `toolMaxEvents` | Register the `camera` tool and bound one result |

A `policy.vehicleDevices` entry that names no provider device and an empty `policy.vehicleActivities` list fail at load. A `modelSelection` route that declares no image input is refused at each event with an error log, and the event is recorded with `MODEL_NOT_VISION`; a doorbell press still notifies.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Events queue by id; a repeated id or an unknown device is ignored. Up to `maxConcurrent` classifications run at once, and an event arriving while `maxQueued` others wait is recorded unclassified with `QUEUE_FULL`. An event without frames skips classification with `NO_FRAMES`.

Each classification opens a root Session with no agent preset and allows one model request. Its Agent scope registers the classification prompt as the complete system prompt in the persona prefix section, so the host persona and every other section are left out; suppresses runtime context; drops every tool schema through a `system-prompt/assemble` listener, which also covers tools other plugins register into the Agent's own scope after creation, such as the schedule tools; and denies every tool execution through a scoped tool guard. The prompt reaches the log as the Session's system message and the request header records no tools. Its only other input is one `user/message` whose source kind is `camera`: the prompt text and the frames as image blocks. The settled assistant text is read tolerantly: the first JSON object in the text is used even inside fences or prose; labels accept common synonyms and plurals; counts, activity, vehicle activity, and confidence are validated separately; confidence accepts percentages; a vehicle activity other than `none` adds the `vehicle` label. A reading with every field valid is `parsed`, one with some fields is `partial`, and text with no JSON object is `unparsed` and keeps its first line. Turn failures are recorded as `TIMEOUT`, `TURN_FAILED`, `NO_ANSWER`, `NOT_PERSISTED`, `SESSION_FAILED`, `MODEL_UNAVAILABLE`, or `MODEL_NOT_VISION`.

The policy runs in code. A doorbell press always yields `ding`. The other reasons need a `parsed` or `partial` verdict at or above `minConfidence`: `package` needs a package with the `delivering` activity, `night-person` a person inside the night window, `vehicle` a listed device and a vehicle activity listed in `vehicleActivities`, and `lingering` person frames whose recorded offsets span at least `lingerSeconds`. The model's own `lingering` activity never triggers a notice. Parked vehicles never notify by default, so a driveway camera that always shows the household's cars stays quiet on headlights, insects, or wind; `passing` is off by default because street traffic past a driveway is not an arrival; an `unknown` vehicle activity, including a verdict stored before the field existed, never notifies.

When `immediateDingNotice` and `policy.ding` are on and a channel is configured, a `camera/preview` for a new doorbell press hands the notice `camera:<event id>:ding` with the text `Someone rang the doorbell` and the first frame to `camera/notice` at once. The classified notice for the same event waits until that handoff settles, so it arrives second. The history record is written before the classified delivery. The classified notice carries the device label, local time, reasons, the description or why it is missing, and the counts with confidence; the frame shown is the first person frame, or the first frame, and is left out when the delivered immediate notice already showed it. `camera/notice` is a serial event; the Discord gateway accepts it into its outbox, which uploads the verified stored frame with the text. The watch retries a handoff that no listener accepts and records the classified delivery as `delivered`, `undelivered`, `no-channel`, or `none`, and the immediate notice's outcome as `earlyDelivery` (`delivered` or `undelivered`) when one was attempted. History fields added after the first release are optional or defaulted, so earlier records keep parsing: a stored verdict without a vehicle activity reads as `unknown`. A retention sweep runs at startup and again `sweepIntervalMs` after the previous sweep ends. It deletes each record older than `retentionDays` or beyond `maxHistory` together with the frames that no kept record and no unfinished event cites, through `ctx.attachments.deleteImage`. A record stays while one of its frames fails to delete, so the next sweep retries it; a frame that is already gone counts as deleted. A sweep that removes anything logs the event and frame counts at info level. A notice still waiting in the Discord outbox when its frame is deleted posts its text alone. No invariant companion is published because history is the only state and every write goes through the storage domain.

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

A separate root Session per event has the fixed system prompt below as its complete system prompt, no runtime context, and no tools. It receives one user message: the instruction below, then the event's frames as images in capture order. The instruction's first line names the alert (`doorbell press` or `motion alert`), the device label, the local date and time, and each frame's offset in whole seconds.

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
- vehicleActivity: "arriving" or "leaving" when a vehicle drives into or out of the driveway or a parking spot across the frames, "passing" when one drives by without stopping, "parked" when every vehicle stays still (lights or a running engine do not count as moving), "none" when no vehicle is visible.
- confidence: how sure you are, from 0 to 1.
- description: one sentence of at most 25 words about what is happening. Do not guess who anyone is.
- personFrames: zero-based indices of the frames that show a person.
```

#### Token effect

Each event costs one request: about 60 system-prompt tokens, about 280 instruction tokens, and one image per frame (three by default), with output capped by `maxOutputTokens`.

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
- **No identities** — verdicts describe people generically; recognizing known faces needs a separate opt-in gallery.
- **Text-only history reads** — the `camera` tool returns descriptions, not the stored frames.
- **Shutdown writes** — a history write that races whole-host shutdown can be lost when the storage facility closes first; plugin reload waits for it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
