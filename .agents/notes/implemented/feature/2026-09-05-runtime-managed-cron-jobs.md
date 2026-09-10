# Agent Note: Runtime-managed cron jobs with guardrails, notes, and delivery

Status: implemented

English | [中文](2026-09-05-runtime-managed-cron-jobs.zh.md)

## Problem

Configuration-only schedules made every job change an edit-and-restart. A running Beardy should be able to keep its own timetable: create a follow-up check, pause a noisy job, delete a finished one — from Discord or any session — while the operator keeps final say over what such a job may become. Two gaps had to close together: jobs needed a durable home outside configuration that survives restarts and is safe to hand to a model, and successive runs of one job had no memory of each other, so each fire repeated work its predecessors had already reported. Delivery also stayed per-tool: a scheduled answer reached Discord only because the prompt told the model to call `discord_send`.

## Decision

Stored jobs live in a `cron_jobs` storage domain with two tables: `jobs` holds stored definitions (zod-validated on load), and `state` holds continuity notes and recent run outcomes for both configured and stored jobs. A registry merges configuration and stored rows into one view and refuses at construction to mount when a name is used by both origins. Configured jobs stay read-only through the management surfaces apart from listing, running now, and notes; the message says so.

`cron_manage` is the model-facing tool (`list`, `create`, `update`, `delete`, `pause`, `resume`, `run_now`, `note`) and `/cron` the human command over the same registry. Guardrails are configuration: `allowedAgentPresets`, `allowedPermissionPresets`, and `allowedWorkspaceRoots` — all empty by default, so creation is refused until the operator opens them — plus `maxStoredJobs`, and `minIntervalMs` checked against the schedule itself through a paused croner probe. Create, update, and delete ask the approval service at call time when `requireApproval` is on (the default); with no answerer mounted they refuse rather than land unapproved.

Every fire's first message carries the job prompt plus a fixed continuity instruction and the stored notes; a run with no notes is told to write what the next run should know before it finishes, through the tool's `note` action. Notes are capped at `notesMaxChars`. A finished run emits the typed event `cron/run-finished` with outcome, final text, session id, and — when configured — a delivery channel; the Discord gateway's `attachCronDelivery` posts that text to the channel, or a one-line outcome note when there is no text and `deliverOutcomes` asks for one. Cron itself names no channel platform.

Timers are owned by a scheduler host (`sync`, `trigger`, per-job in-flight guard). Any write to the `jobs` table re-plans every timer from the registry's current view; in-flight guards survive the re-plan, so editing a stored job cannot leave a stale timer or double-run an active one.

## Alternatives considered

One table with notes and history inline in each job record was rejected: configured jobs need the same notes and history fields, which would mean rewriting configuration-owned rows on every run, and a separate `state` table keeps durable writes off the read-only origin while both origins share one continuity mechanism.

Letting stored jobs override or edit configured ones was rejected: configuration is the operator's declaration, and a model-visible mutation that silently changes it breaks the restart contract. A name collision refuses to load instead of choosing a winner.

Approving at the registry (so every writer pays) was rejected in favor of gating in the management tool: the registry also serves internal callers (`/cron` verbs are operator intent already), and the approval service may be absent, which is a refusal reason rather than a construction-time dependency.

Cron posting to Discord directly was rejected: delivery belongs to whoever owns the channel. The typed event keeps cron platform-neutral and leaves room for Web or other listeners without touching this package.

Making notes free-form session memory (curated memory, `dsh-memory`) was rejected for this seam: continuity here is one bounded string per job that every fire reads verbatim, not recall across sessions; a search step would add cost and nondeterminism to an unattended run.

## Consequences

Automatic outcome delivery and cold reminder recovery follow the [durable delivery decision](2026-09-07-durable-personal-agent-delivery.md).

A model can now restructure the timetable, so blast radius is configuration-bounded: presets, workspace roots, count, frequency, and (by default) one approval per mutation. The empty-default allowlists mean runtime creation is dead until a profile opens it — deliberate, and stated in the README's Known Limitations.

Unattended runs have no answerer, so `cron_manage` writes from an unattended session refuse on approval unless the operator turns `requireApproval` off; interactive sessions with the Discord answerers approve by reaction or reply as any other gated tool does.

Notes make a job's first message vary between fires: two fires of the same job share no cached prefix, and changing notes changes that prefix again. The cap bounds the cost.

Only the final assistant text or an enabled outcome notice travels through the gateway's durable delivery queue. `run_now` on a paused job refuses with its own message rather than silently arming it. Sessions still accumulate — deleting a job leaves its past run sessions on disk, as before.
