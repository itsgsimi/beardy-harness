# Agent Note: Camera first-frame motion notices, vehicle count arrivals, and Ring signalling log noise

Status: implemented

English | [中文](2026-09-28-camera-early-notice-and-arrivals.zh.md)

## Problem

A live run on 2026-09-28 showed three faults. A front-door person reached Signal 35 seconds after the motion alert, because the watch classifies only after every frame is captured and the floodlight camera's live stream takes about 25 seconds to start. A family car arriving at the garage was read as `parked` ("A dark SUV is parked in the driveway with its door open, next to a blue pickup truck and another light-colored car"), so the default `arriving`/`leaving` vehicle rule stayed quiet although the vehicle count rose from 2 at the previous garage event to 3. The `ring-client-api` logger bridge wrote pairs of `UNKNOWN MESSAGE` and inspected signalling messages at `warn` during every live stream, and those dumps carried the signalling `session_id` JWT into the journal.

## Decision

**A motion event's first frame is classified on its own.** The [doorbell preview](2026-09-27-camera-live-run-tuning.md) already delivers each event's first stored frame through `camera/preview`. With `earlyMotionNotice` (default true) and a channel, the watch now queues a classification of that one frame for a new motion event: the same tool-free logged Session path, with an instruction stating that the image is only the first frame and a source summary ending in `(first frame)`. When the policy yields a reason for that verdict, `camera:<id>:early` posts at once with the frame and the line `From the first picture; an update follows only if the rest shows more.` Doorbell presses keep their `Someone rang the doorbell` notice and no first-frame check. The vehicle count comparison and the lingering reason need the full event, so the early check can yield `person`, `night-person`, `package`, or a model-reported `vehicle` activity.

**The full notice becomes an update only when it adds something.** After a delivered early motion notice, the classified notice posts only when its reasons include one the early notice did not state or its verdict counts more of any label than the first frame did; its heading reads `<time> (update)`. Descriptions are not compared, since two answers seldom word one scene alike. Otherwise `delivery` stays `none`. A failed, reasonless, or refused early notice leaves the classified notice unchanged.

**First-frame checks share the classification slots.** They count against `maxConcurrent`, run ahead of every queued event, and are skipped when every slot is busy and `maxQueued` events already wait. Priority also guarantees that an event holding a slot while it waits for its own early notice never waits on a job that still needs a slot. Disposal settles queued checks unclassified.

**Vehicle counts back up the model's vehicle activity.** On a `vehicleDevices` camera the full verdict's vehicle count is compared with the device's latest earlier record inside `policy.arrivalBaselineMs` (default 12 hours, 0 off, at most seven days) whose verdict reaches `minConfidence`; the event's own verdict must reach it too. More vehicles read as `arriving` and fewer as `leaving`, replacing the model's activity for the `vehicle` rule and the headline. The instruction now also names a stopped vehicle with a door open, lights on, or a person getting in or out, and a vehicle present only in later frames, as `arriving`, and `parked` requires closed doors and nobody getting in or out.

**History states both checks.** Optional record fields `earlySessionId`, `earlyReasons`, `vehicleChange`, and `baselineEventId` join the existing `earlyDelivery`, so earlier records parse under domain version 1 and the model's own verdict stays unchanged.

**Signalling chatter leaves the warning level and tokens leave the log.** The Ring logger bridge sends `UNKNOWN MESSAGE` and any error text that is an inspected object carrying `doorbot_id` to `debug` (`info` with `vendorDebug`). Every bridged line redacts `session_id` values and JWT-looking values after the refresh-token secrets, then keeps the 300-character bound. Other library errors stay at `warn`.

## Alternatives considered

**Classify frames incrementally and notify from the running verdict.** Each additional frame would be another request and another Session per event, and the policy would need to reason about partial frame sets; one extra single-frame check covers the latency that matters.

**Always post the full notice after an early one.** It repeats the early message for most events, which is the noise the watch exists to avoid.

**Compare descriptions to decide on an update.** Model wording varies between requests, so almost every event would post an update.

**Order the event after its preview instead of prioritizing checks.** The queue then needs per-event dependencies; a separate first-frame queue served first keeps one invariant.

**Decide arrivals only from the prompt.** The live verdict shows the model can call an arrival `parked`; the count comparison is a deterministic backstop that needs no new model output.

**Drop the library's error lines entirely.** A real signalling failure would then disappear; only the recognized chatter is demoted.

## Consequences

Every motion event costs one extra single-image classification while a channel is configured, and a person or vehicle visible in the first snapshot notifies within the snapshot and classification time instead of after the whole capture. An early notice can name something the rest of the event does not confirm; the update never retracts it. The first vehicle event inside the baseline window has nothing to compare with, and a vehicle the model miscounts in either event reads as an arrival or a departure. The journal no longer carries signalling session tokens or per-stream `UNKNOWN MESSAGE` warnings.

The watch tests pin the early notice text and frame, the suppressed and posted updates, first-frame failure, refusal, and reasonless cases, slot priority, queue-full skip and disposal, both logged Sessions, and arrivals and departures from counts with the window and confidence bounds. The Ring tests pin the exact live shapes of the chatter and the redaction. The `camera-watch` session snapshot pins the revised instruction.
