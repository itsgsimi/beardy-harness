---
description: "Camera event service, Ring provider, and the watch that classifies, notifies, and answers the camera tool."
kind: "package-group"
---

# packages/camera

English | [中文](README.zh.md)

## Summary

Turn doorbell presses and motion alerts into short, accurate notices. The Ring provider captures a few frames per event; the watch classifies them in one logged vision-model turn, applies a notification policy, sends the notice with a frame through the Discord gateway outbox, and keeps an event history that the `camera` model tool reads.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [camera](camera/README.md) | Devices, events, frames, and verdict types | `ctx.camera` definition |
| [camera-ring](camera-ring/README.md) | Ring account connection, push events, and frame capture | `ctx.camera` provider |
| [camera-watch](camera-watch/README.md) | Classification turn, notification policy, history, and the `camera` tool | service consumer |

-----

<a id="related-documentation"></a>
## Related documentation

- [Camera subsystem](../../docs/subsystems/camera.md) — events, frames, verdicts, and the notice handoff.

-----

<a id="dev-note"></a>
## Dev Note

None.
