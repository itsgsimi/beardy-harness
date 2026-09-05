---
description: "Unattended scheduled agent runs on the Host: cron jobs from configuration each open their own session, run their prompt through a chosen preset pair, and report the outcome in the log, for operators who want an agent to act on a timetable."
kind: "package-reference"
---

# @deepseek-ai/dsh-cron

English | [中文](README.zh.md)

## Summary

The package runs agents on a timetable with nobody watching. Each configured job names a cron expression, an IANA timezone, a prompt, and the pair of presets that shape the run: an agent preset for the composition and a permission preset for what it may do in its workspace. When a schedule fires, the package opens a fresh session, mounts that composition, hands the prompt over as a user message carrying cron provenance, and records how the run ended — answered, no text answer, timed out, or failed. Schedules are validated when configuration loads, so an unusable expression or a duplicate job name stops startup instead of silently never firing. A run that is still going when its next fire arrives is not started twice. Jobs come from configuration only; nothing creates or edits them at runtime.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="model-experience"></a>
## Model Experience

### Fire prompt

#### What the model sees

A run's first request carries the job's `prompt` as one user-role message, with provenance the surfaces render as a notice: the job name and the scheduled fire time. The session has no earlier turns and no other input source, so the prompt is the whole assignment; anything the run needs to know must be in the prompt itself or reachable through the mounted composition's tools.

#### Token effect

One user message per fire, plus whatever the run's own tool calls add. Each run is a separate session, so cost repeats per fire rather than accumulating into one long conversation; `turnTimeoutMs` bounds how long a single run may keep going.

#### KV Cache effect

Every fire starts a new session whose preset composition forms its own initial prefix, so runs do not share cached history with each other. Within one run, appended turns stay reusable as usual.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Configuration-only jobs** — there is no Service method or model-facing tool that creates, edits, pauses, or deletes a job; adding one means editing configuration and restarting. Runtime job management is the next piece of this feature.
- **No delivery of its own** — a run reaches the world only through tools its preset mounts, such as `discord_send`; with no delivery tool the answer stays in the session log.
- **Fires during downtime are not made up** — a schedule that should have fired while the process was stopped is skipped when it comes back; the next scheduled time runs normally.
- **One overlapping fire per job** — a still-running job causes the next fire to be logged as skipped rather than queued, so a run longer than its own period loses those fires.
- **Sessions accumulate** — mounted runs are trimmed oldest-first past `maxLiveRuns` in memory, and the durable sessions each fire creates stay on disk; the package deletes nothing.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`schedule.ts` wraps croner behind a `Scheduler` seam (`cronerScheduler`, plus `assertSchedule` which validates a pattern without scheduling), so tests mount jobs with a fake scheduler and assert the real one fires on a one-second pattern. `launch.ts` owns session creation order — agent preset resolve, permission preset resolve, workspace registration, session id, `agents.create`, attach, permission apply, title — and rolls back to detach plus dispose when any later step fails. `index.ts` validates configuration, skips overlapping fires, and keeps the in-flight guard; `apply` reads the resolved config so a patched value is what runs.

</details>

**Runtime invariant:** No companion is published. Schedules, timers, and mounted sessions belong to the plugin fiber and are stopped when it stops; `tests/loader-composition.spec.ts` boots the real Loader and proves an unusable configuration refuses to load.
