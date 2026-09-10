---
description: "Unattended scheduled agent runs on the Host: configured and runtime-created cron jobs each open their own session, run their prompt through a chosen preset pair, carry continuity notes between fires, and announce finished runs for channel delivery, for operators who want an agent to act on a timetable."
kind: "package-reference"
---

# @deepseek-ai/dsh-cron

English | [中文](README.zh.md)

## Summary

The package runs agents on a timetable with nobody watching. A job names a cron expression, an IANA timezone, a prompt, and a pair of presets: an agent preset for its tools and a permission preset for its workspace authority. Each accepted fire reserves a Session id durably before opening the Session, submits the prompt with cron provenance, and records whether the run answered, produced no text, timed out, failed, or was interrupted.

Jobs arrive from two places. Configuration lists them at load; an operator can also let the agent manage jobs at runtime through the `cron_manage` tool and the `/cron` command. Stored jobs live in the `cron_jobs` storage domain and survive restarts; configured jobs stay read-only apart from listing, running now, and notes. Guardrail configuration bounds what a stored job may name: allowed agent presets, allowed permission presets, allowed workspace roots, a maximum job count, and a minimum interval between fires — with empty allowlists, creation is refused until the operator opens them. Mutating actions ask the approval service when `requireApproval` is on. Every job carries continuity notes that are injected into each fire so successive runs continue instead of repeating themselves. A finished run emits `cron/run-finished`; the Discord gateway listens for it and posts the run's text to the job's delivery channel, or an outcome line when there is no text and `deliverOutcomes` asks for one. Schedules are validated when configuration loads, so an unusable expression or a duplicate job name stops startup instead of silently never firing. A run that is still going when its next fire arrives is not started twice.

Each fire reads the current definition and continuity notes; saving notes does not restart its timer. Shutdown stops new fires, cancels active runs, records their interrupted outcomes, and drains delivery handoffs before closing storage. On restart, unfinished reservations become interrupted history entries. The scheduler does not repeat their Agent work or make up occurrences missed while the process was stopped; it resumes at the next future expression match.

Finished text and its channel destination remain durable until a `cron/run-finished` listener returns `true` after accepting delivery. An unavailable listener or failed handoff leaves the output pending, retried every `deliveryRetryMs` (default `30000`) and before another run of that job. Recovery retries delivery without another model request. Delivery listeners deduplicate by Session id and fire time. A pending run or handoff prevents deleting its stored job; pausing still stops future fires. The `keepRunHistory` limit applies to terminal history, independently of pending output.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="model-experience"></a>
## Model Experience

### Fire prompt

#### What the model sees

A run's first request carries the job's `prompt`, a fixed continuity instruction, and the current notes from earlier runs, inside one user-role message naming the job and fire time. A first run is told to record what the next run should know before finishing. When the job names a delivery channel, the prompt tells the model that its final answer will be delivered automatically and that it must not send the same content separately with `discord_send`.

#### Token effect

One user message per fire — prompt, continuity instruction, and notes — plus whatever the run's own tool calls add. Each run is a separate session, so cost repeats per fire rather than accumulating into one long conversation; `turnTimeoutMs` bounds how long a single run may keep going.

#### KV Cache effect

Every fire starts a new session whose preset composition forms its own initial prefix, so runs do not share cached history with each other. Notes change that prefix between fires when they change; within one run, appended turns stay reusable as usual.

### `cron_manage` tool

#### What the model sees

One tool with an `action` enum: `list`, `create`, `update`, `delete`, `pause`, `resume`, `run_now`, and `note`. Create names the schedule, timezone, prompt, preset pair, workspace, and optionally a title and a delivery channel. Results are short confirmation lines plus, for `list`, one line per job with its origin (`config` or `stored`) and arm state.

#### Token effect

The schema sits in every request of any session that has the tool mounted; each call adds one small result. Guardrail refusals come back as tool errors naming the violated bound, so a rejected create costs one round.

#### KV Cache effect

Registration is static per composition, so the schema does not churn mid-session. Results append normally.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Creation stays locked until opened** — `allowedAgentPresets`, `allowedPermissionPresets`, and `allowedWorkspaceRoots` default to empty, so a stored create is refused until the operator whitelists presets and roots in configuration.
- **Gated writes need an approval service** — with `requireApproval` on (the default) and no approval service mounted, create, update, and delete refuse rather than land unapproved.
- **Delivery needs an accepting listener** — `cron/run-finished` uses an awaited serial handoff. A channel-bound outcome stays pending until a listener durably accepts it; the scheduler waits for that acceptance before starting another run of the same job.
- **Fires during downtime are not made up** — a schedule that should have fired while the process was stopped is skipped when it comes back; the next scheduled time runs normally.
- **One overlapping fire per job** — a still-running job causes the next fire to be logged as skipped rather than queued, so a run longer than its own period loses those fires.
- **Sessions accumulate** — completed runs are released oldest-first past `maxLiveRuns`; active runs remain mounted until they settle. Durable Session logs stay on disk.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`schedule.ts` wraps croner behind a `Scheduler` seam (`cronerScheduler`, plus `assertSchedule` which validates a pattern without scheduling), so tests mount jobs with a fake scheduler and assert the real one fires on a one-second pattern. `domain.ts` defines the `cron_jobs` storage domain: the `jobs` table holds stored definitions, the `state` table holds notes and run history for both origins. `registry.ts` merges configured and stored jobs into one view, enforces the guardrails on every mutation, and refuses a name used by both origins at construction. `launch.ts` owns session creation order — agent preset resolve, permission preset resolve, workspace registration, session id, `agents.create`, attach, permission apply, title — and rolls back to detach plus dispose when any later step fails. `index.ts` hosts the live timers (`createSchedulerHost`: sync, trigger, overlap guard) and re-plans them when a write lands in the `jobs` table; `tool.ts` and `command.ts` are the model-facing and human-facing surfaces over the registry, with the approval service read at call time.

</details>

**Runtime invariant:** The companion asserts nothing beyond record validation: durable job records are zod-validated on load and every mutation lands in the storage domain before it becomes visible, so no independent observation can diverge from them. `tests/loader-composition.spec.ts` boots the real Loader and proves an unusable configuration refuses to load and a stored job is scheduled after restart.
