# Agent Note: Camera watch notifies any person on chosen cameras

Status: implemented

English | [中文](2026-09-28-camera-person-devices.zh.md)

## Problem

The camera watch notified a person only inside the night window (`night-person`) or when person frames spanned at least `lingerSeconds` (`lingering`). A daytime visitor who walked up to the front door and left within a few seconds produced no notice. The household wants every person the front-door camera sees reported, day or night, while the garage camera keeps its strict vehicle-only rules.

## Decision

**A per-device list, not a global switch.** `policy.personDevices` (default empty) lists device ids where a verdict with the `person` label notifies at any hour. It passes the same gate as every other verdict rule: a `parsed` or `partial` verdict at or above `minConfidence`. It mirrors `policy.vehicleDevices`: entries are deduplicated, and an entry that names no provider device fails at load with `camera-watch: policy.personDevices names unknown camera device "<id>"`. A deployment adds `policy: { personDevices: [front-door] }`.

**A separate `person` reason after `night-person`.** The canonical order is `ding`, `package`, `night-person`, `person`, `vehicle`, `lingering`. `person` is independent of `nightPerson`, so turning the night rule off keeps the device rule. When both apply, history and the `camera` tool keep both reasons, because each names a rule that matched; the notice renders one headline, `Person at night`, because a second `Person at <device label>` would restate it. Alone, the headline is `Person at <device label>`, for example `Person at Front door`.

**Additive history.** The stored reasons enum gains `person` and is derived from the same `NOTICE_REASONS` list as the reason type. Records written before it still parse, so the domain version stays 1.

## Alternatives considered

**A global `anyPerson` flag.** It would also notify every person on the garage camera, which the household wants quiet.

**Per-device night windows.** A window covering the whole day can express the rule, but a zero-length or full-day window is an unclear configuration for "always".

**Fold the device rule into `night-person`.** History would lose which rule matched, and a device-rule notice at noon would read `Person at night`.

## Consequences

A front-door camera on the list posts a notice for every confident person verdict, including passers-by on the pavement it can see; `minConfidence` is the only filter. An earlier build's history schema does not accept a record carrying `person`, so rolling back past this change is unsupported once such records exist.

The policy tests pin the daytime notice on a listed device, silence on an unlisted device and below the confidence floor, both reasons at night, and the device rule with `nightPerson` off. The watch tests pin the end-to-end notice text, the garage staying quiet, and the load failure for an unknown id; the history tests pin earlier and new records. The `camera-watch` session snapshot is unchanged because its configuration does not list person devices.
