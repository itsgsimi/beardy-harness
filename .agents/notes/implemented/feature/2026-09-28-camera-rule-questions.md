# Agent Note: Camera classification asks the questions the notice rules need

Status: implemented

English | [中文](2026-09-28-camera-rule-questions.zh.md)

## Problem

The camera watch classifies frames with a small vision model (Qwen3.5 4B, thinking off) that answered one free-form verdict: labels, counts, an activity, a vehicle activity, a self-reported confidence, and person frames. The model reported confidence 0.95 on almost every event, so `policy.minConfidence` filtered nothing. It could not tell a passer-by on the sidewalk from a person in the driveway, so a garage camera listed in `personDevices` notified on street traffic. It described a car that had just pulled in with its door open as `parked`, so the arrival went unnoticed. The verdict asked the model to summarize the scene in words the rules then had to reinterpret.

## Decision

**Each classification asks exactly the yes-or-no questions the device's enabled rules read.** The camera Definition replaces the verdict's `activity`, `vehicleActivity`, `confidence`, and `personFrames` with `answers`: `person_on_property`, `person_at_door`, `person_staying`, `package_present`, `package_being_delivered`, `vehicle_arriving`, and `vehicle_leaving`, each `{ answer, frames }` with the zero-based frames that show it. Labels, counts, and a description of at most 25 words stay, because history, the `camera` tool, and the vehicle count baseline read them. `askedQuestions` derives the set from the policy: person questions for the night, `personDevices`, and lingering rules; `person_at_door` on a new `policy.doorDevices` camera and for any doorbell press, since the Definition does not say which device is a doorbell; `person_staying` with two or more frames; `package_present` only when a baseline can show the package is new; vehicle questions on `vehicleDevices` for each movement `vehicleActivities` lists, now only `arriving` and `leaving`. A first-frame check drops `person_staying`, `package_present`, and `vehicle_leaving`. The instruction gives one short definition line per question with the tie-breakers: the sidewalk and street are not the property; a vehicle waiting at the entrance with its lights on, or standing with a door open or a person getting out, is arriving; a parked car with doors closed is neither.

**A per-device scene tells the model where the property ends.** A validated `devices: [{ id, scene? }]` list in the watch configuration inserts each scene verbatim as `Scene: <text>`. Devices come from the provider, so the watch checks the ids when it starts, as it does for the policy lists. The README carries the front-door and garage scenes as examples; the deployment sets them.

**Evidence frames replace confidence.** A true answer without a valid evidence frame reads as false, and `policy.minConfidence` is deprecated: still accepted by the schema, ignored, and warned about at load. Rules map answers to reasons: a person is seen when `person_on_property` or `person_at_door` is true (`person`, `night-person`); `package` needs `package_being_delivered`, or `package_present` when the device's baseline record answered it false, so a box left between two events notifies once; `vehicle` takes the first listed movement among the vehicle count change, `vehicle_arriving`, and `vehicle_leaving`; `lingering` needs `person_staying` and person evidence frames spanning `lingerSeconds`. The baseline is the device's latest record inside `arrivalBaselineMs`, without a confidence filter.

**The reader is a per-field schema over prompt-and-parse output.** It keeps the fence- and prose-tolerant object search, checks each field with zod, keeps valid answers from a partial object, and ignores fields for questions not asked. History stores answers additively: `answers` defaults to empty, and the old verdict fields become optional, so records written before this change parse under domain version 1 and the tool shows their stored fields.

**The exact request is a pure function.** `renderClassificationRequest(config, event)` returns the system prompt, instruction, and questions for a written configuration, so a replay script can compare prompts on stored events; the watch builds every request through the same `classificationRequest`.

**First-frame checks can take their own model route, and an answer that states nothing is a failure.** A replay of 32 stored events on 2026-09-28 with this prompt measured Qwen3.5 4B (thinking off) at a median 4.0 s, but on two multi-frame events, a person on the porch and an SUV pulling in with its door open, it returned the JSON template unchanged: an empty description, no labels or counts, and every answer false, which read as nothing happened. Flash Next (thinking off, same prompt) took a median 10.2 s, never echoed the template, and answered every key event correctly. The first-frame check, which sees one frame and exists to be fast, stays on the 4B through a validated `earlyModelSelection` with the same shape and image-input route check as `modelSelection`; the full classification uses Flash Next. Without `earlyModelSelection`, first-frame checks use `modelSelection` as before, and setting it while `earlyMotionNotice` is off fails at load. The startup route check logs `camera-watch: classifying with <full> (first frame: <early>)` when the routes differ and reports a failure of either. An answer object with no description or a blank one, no labels, no counts, and no asked question answered true fails as `EMPTY_ANSWER`, which counts toward the failure notice like `NO_ANSWER`; for a first-frame check it only means no early notice, and the full classification still runs. With its own route, a first-frame check keeps its own failure run, notice interval, and notices (`camera-watch:first-frame-failing:<window start>`, `⚠️ Camera first-frame checks are failing (<code>: <cause>). Motion alerts wait for the full check.`); without one, both stages share one failure state as before.

## Alternatives considered

**Schema-forced JSON and log-probabilities for confidence.** The LLM seam carries neither a response format nor log-probabilities; adding them changes the core call configuration and the request header. That is the second phase, taken only if these questions leave gaps.

**Keep `minConfidence` gating the answers.** A self-reported number that is always 0.95 gates nothing; evidence frames are checkable.

**Ask every question on every device.** Unused questions cost tokens and give a small model more chances to answer beside the template.

**Add a doorbell flag to the camera Definition.** Only the door question needs it, a doorbell press already marks the device for that event, and `doorDevices` covers a door camera without a button.

**Put scenes on the provider's device list.** Scenes are prompt text owned by the classifier, not by the vendor adapter.

**Count first-frame failures in the full classification's run.** Each event runs both stages, so a working full route's answers would end a failing fast model's run before it reached the threshold, and a notice raised by the fast model would wrongly say motion alerts are paused.

**Match only a verbatim copy of the template.** Whitespace, key order, or one dropped question defeats an exact comparison; the structural check covers every verbatim copy and those variants.

**Run everything on Flash Next.** It never echoed, but its 10.2 s median delays the first-frame notice that exists to arrive before the full check.

## Consequences

A sidewalk passer-by answers `person_on_property` false and notifies nothing; a person in the driveway or at the door notifies on a person device; a car stopping with its door open notifies as arriving. Classification requests carry about 250 to 450 instruction tokens depending on the scene and questions, and notices no longer print a confidence. A small model can still skip a question, which then reads as unanswered and notifies nothing. The tests pin the golden prompts for a front door and a garage, parsing edge cases, the policy mapping, records written before this change, the package baseline, and the early path; the `camera-watch` session snapshot pins the new request and answer. A replay on 2026-09-28 of 32 stored events made the 4B's template echo on multi-frame events visible; `EMPTY_ANSWER` now records such a reply as a failed classification, and the split route keeps the fast model where only speed matters.
