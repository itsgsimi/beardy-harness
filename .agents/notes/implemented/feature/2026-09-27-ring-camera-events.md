# Agent Note: Ring camera events classified by a logged vision turn

Status: implemented

English | [中文](2026-09-27-ring-camera-events.zh.md)

## Problem

Goran has a wired Ring doorbell and a wired floodlight camera above the garage, without a Ring Protect plan, so Ring sends plain motion and doorbell pushes with no recordings and no person or package labels. He wants Beardy to tell him about a doorbell ring with a description, a delivered package, an unknown person at night, a vehicle in the driveway, and someone lingering, and to stay quiet otherwise. Identities come later; verdicts stay generic now.

## Decision

The camera capability is a seam of three packages. `@deepseek-ai/dsh-camera` defines `ctx.camera`: configured devices and the parallel `camera/event`, whose frames are `ImageAttachmentRef`s already committed to the attachment store, plus the verdict type. `@deepseek-ai/dsh-camera-ring` implements it on `ring-client-api` 14.3.0 (MIT, ESM, maintained by one author with releases every few months). The refresh token is read by credential reference and every rotation, including push-credential re-encoding, is written back through `ctx.credentials.set`; load fails when the reference is unset or read-only, because an unpersisted rotation strands the next restart. The provider admits each vendor event id once, applies per-device and per-kind cooldowns, drops motion that overlaps a capture, and captures up to three frames: snapshots at the event time and ten and twenty seconds after, with one live stream through the host's ffmpeg for the remaining slots when a snapshot fails or repeats the previous one ([live-run tuning](2026-09-27-camera-live-run-tuning.md)). ffmpeg's own download script is denied in `allowBuilds`; the absolute `ffmpegPath` is required with the fallback.

`@deepseek-ai/dsh-camera-watch` consumes the events. Each classification is a root Session with no preset, its own complete system prompt, no tools, and one allowed model request; its single `user/message` carries source kind `camera`, the prompt, and the frames as image blocks, so the model input stays reconstructable from the log. The verdict parser accepts fenced or surrounded JSON, label synonyms, and percentages, and grades the reading `parsed`, `partial`, or `unparsed`. The policy is code: every ding, a package with the `delivering` activity, a person inside the night window, a vehicle arriving or leaving on listed devices, and person frames whose recorded offsets span `lingerSeconds`. A route that declares no image input is refused per event instead of silently degrading images to text. Notices go through a serial `camera/notice` that the Discord gateway accepts into its durable outbox; an outbox body variant keeps the image reference, and the post reads and verifies the frame, then uploads it through a new multipart path in `dsh-tool-discord`. History lives in the `camera_watch` storage domain with age and count bounds, and the read-only `camera` tool answers from it.

## Alternatives considered

**Rely on Ring's smart alerts.** Person and package labels need a Ring Protect plan that Goran does not have.

**Classify outside the session log**, for example with a direct adapter call. It would put images in front of a model without a durable record, which breaks model-visible ⟺ logged.

**Let the model decide lingering.** A classifier's `lingering` label is an opinion about time it cannot see; the recorded frame offsets decide instead.

**A second Discord client for image posts.** The gateway already owns the bot connection, the outbox, retries, and restart recovery; one outbox variant reuses all of it.

## Consequences

Classification Sessions persist beyond `retentionDays` because session persistence has no deletion; [frame retention](2026-09-27-camera-frame-retention.md) deletes expired history records together with their frames. One harness process should own the Ring token. The host needs outbound TCP 5228 for Ring pushes. A pending image delivery written by this build fails to parse on an older gateway build, so a downgrade needs the outbox drained first. Tests replace the Ring client and never contact Ring, Discord, or a model; the `camera-watch` snapshot replays one classification turn with a synthetic frame.
