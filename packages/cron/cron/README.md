---
description: "Unattended scheduled agent runs on the Host: configured and runtime-created cron jobs each open their own session, run their prompt through a chosen preset pair, carry continuity notes between fires, and announce finished runs for channel delivery, for operators who want an agent to act on a timetable."
kind: "package-reference"
---

# @deepseek-ai/dsh-cron

English | [中文](README.zh.md)

## Summary

The package runs unattended agents on validated cron schedules. Configuration supplies read-only jobs; operators may also manage durable jobs through `cron_manage` and `/cron`, within configured preset, workspace, count, interval, and approval limits. Each fire opens a Session, injects continuity notes, records its terminal outcome, and avoids overlapping runs. Optional Discord delivery remains durable and retries without repeating model work. Shutdown interrupts active runs cleanly; restart records abandoned reservations and resumes only at the next future schedule match.

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

**Runtime invariant:** No companion is published. Durable job records are zod-validated on load and every mutation lands in the storage domain before it becomes visible, so no independent observation can diverge from them. `tests/loader-composition.spec.ts` boots the real Loader and proves an unusable configuration refuses to load and a stored job is scheduled after restart.
