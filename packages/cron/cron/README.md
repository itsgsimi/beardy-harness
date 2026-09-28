---
description: "Unattended scheduled agent runs on the Host: configured and runtime-created cron jobs each open their own session, run their prompt through a chosen preset pair, carry continuity notes between fires, and announce finished runs for channel delivery, for operators who want an agent to act on a timetable."
kind: "package-reference"
---

# @deepseek-ai/dsh-cron

English | [中文](README.zh.md)

## Summary

The package runs agents on cron schedules. Configuration supplies read-only jobs; operators manage durable jobs through `cron_manage` and `/cron` within preset, workspace, count, interval, and approval limits. A started fire opens a Session with continuity notes. Every fire records an outcome, including `skipped` when prior work is pending or its local model route is intentionally unloaded. Discord delivery retries without repeating model work. Shutdown interrupts runs; restart records abandoned reservations and resumes at the next match.

An active run exposes its `deliverChannel` to the Discord approval answerer only during that run. A run without a channel cannot obtain home-write approval.

## Table of Contents

- [Model selection](#model-selection)
- [Commands](#commands)
- [Delivery targets](#delivery-targets)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## Model selection

`modelSelection: { provider, model, reasoningEffort? }` on the cron row selects an exact route for every fire, including stored jobs; a configured job can override it with its own `modelSelection`. Without either choice, the run inherits the full current `agentDefaultModel` selection. Each fire checks its explicit choice against the registered adapter before opening a Session; an unknown route or unsupported effort fails that run with the job named. The effective choice appears in the Session's `request/header`.

-----

## Commands

`/cron status [name]` works in Discord and Web command input without a model turn. It shows the last retained outcome, outcome id, elapsed duration when recorded, failure or skip code and cause, and the next armed fire. A skipped fire has no Session. Earlier history without duration displays `unknown`. A failed run's existing Discord outcome notice includes its job, Session id, failure code, and next fire; a skipped fire uses that same outcome path when notices are enabled.

-----

<a id="delivery-targets"></a>
## Delivery targets

`deliverChannel` and the `deliver_channel` tool field accept a Discord channel id, `discord:<id>`, `signal:group:<base64 id>`, or `signal:number:<E.164>`, and reject anything else at load or in the tool before approval; jobs stored before this check keep their target. The owner of the target's transport claims `cron/run-finished` and posts the text `cronDeliveryContent` selects. Only Discord targets receive approval prompts, so a run delivering to Signal cannot obtain home-write approval.

-----

<a id="model-experience"></a>
## Model Experience

### Fire prompt

#### What the model sees

A run's first request carries the job's `prompt`, a fixed continuity instruction, and the current notes from earlier runs, inside one user-role message naming the job and fire time. A first run is told to record what the next run should know before finishing. When the job names a delivery channel, the prompt tells the model that its final answer will be delivered automatically and that it must not send the same content separately with `discord_send`.

#### Token effect

One user message per fire — prompt, continuity instruction, and notes — plus whatever the run's own tool calls add. Each run is a separate session, so cost repeats per fire rather than accumulating into one long conversation; a job's optional `turnTimeoutMs` bounds its run, with the plugin `turnTimeoutMs` as the default.

#### KV Cache effect

Every fire starts a new session whose preset composition forms its own initial prefix, so runs do not share cached history with each other. Notes change that prefix between fires when they change; within one run, appended turns stay reusable as usual.

### `cron_manage` tool

#### What the model sees

One tool with an `action` enum: `list`, `create`, `update`, `delete`, `pause`, `resume`, `run_now`, and `note`. Create requires a name, schedule, timezone, prompt, preset pair, and workspace; a title, per-job timeout, and delivery channel are optional. Update requires a name and at least one patch field; delete, pause, resume, and run_now require a name; note requires a name and replacement notes. Results are short confirmation lines plus, for `list`, one line per job with its origin (`config` or `stored`) and arm state.

#### Token effect

The schema sits in every request of any session that has the tool mounted; each call adds one small result. Missing-field errors name the fields required by that action. Notes over the configured `notesMaxChars` cap are refused with a request to condense them; other guardrail refusals name the violated bound.

#### KV Cache effect

Registration is static per composition, so the schema does not churn mid-session. Results append normally.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Creation stays locked until opened** — `allowedAgentPresets`, `allowedPermissionPresets`, and `allowedWorkspaceRoots` default to empty, so a stored create is refused until the operator whitelists presets and roots in configuration. Workspace and root paths are compared by `realpath` on create and update; every fire rechecks the stored workspace and records a failed outcome if it escapes the roots.
- **Gated writes need an approval service** — with `requireApproval` on (the default) and no approval service mounted, create, update, delete, resume, run_now, and note refuse rather than land unapproved. Approval requests show the proposed job or field changes, and the tool applies the approved values.
- **Delivery needs an accepting listener** — `cron/run-finished` uses a bounded serial handoff. A channel-bound outcome stays pending until a listener durably accepts it. If the previous run's output cannot be delivered within the job's timeout, the next fire records `skipped` with `PREVIOUS_OUTCOME_PENDING`. Skipped notices retry without blocking later starts.
- **Fires during downtime are not made up** — a schedule that should have fired while the process was stopped is skipped when it comes back; the next scheduled time runs normally.
- **One overlapping fire per job** — a still-running job causes the next fire to be recorded as `skipped` with `PREVIOUS_RUN_IN_PROGRESS` rather than queued. The history row and optional Discord notice retain the reason. Session cleanup of other jobs does not hold the overlap guard.
- **Sessions accumulate** — completed runs are released oldest-first past `maxLiveRuns`; active runs remain mounted until they settle. A handle whose disposal never settles may retain resources after its release timeout; cron logs the unresolved teardown and continues. Durable Session logs stay on disk.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`schedule.ts` wraps croner behind a `Scheduler` seam (`cronerScheduler`, plus `assertSchedule` which validates a pattern without scheduling and `latestMatchAt` which finds the latest match at or before an instant for a caller's restart catch-up), so tests mount jobs with a fake scheduler and assert the real one fires on a one-second pattern. `domain.ts` defines the `cron_jobs` storage domain: the `jobs` table holds stored definitions, the `state` table holds notes and run history for both origins. `registry.ts` merges configured and stored jobs into one view, enforces the guardrails on every mutation, and refuses a name used by both origins at construction. `launch.ts` owns session creation order — agent preset resolve, permission preset resolve, workspace registration, session id, `agents.create`, attach, permission apply, title — and rolls back to detach plus dispose when any later step fails. `index.ts` hosts the live timers (`createSchedulerHost`: sync, trigger, overlap guard) and re-plans them when a write lands in the `jobs` table; `tool.ts` and `command.ts` are the model-facing and human-facing surfaces over the registry, with the approval service read at call time.

</details>

**Runtime invariant:** No companion is published. Durable job records are zod-validated on load and every mutation lands in the storage domain before it becomes visible, so no independent observation can diverge from them. `tests/loader-composition.spec.ts` boots the real Loader and proves an unusable configuration refuses to load and a stored job is scheduled after restart.
