# Agent Note: Cron runs save their own continuity notes

Status: implemented

English | [中文](2026-09-30-cron-self-notes.zh.md)

## Problem

On 2026-09-30 the daily-digest and morning-brief cron runs followed their continuity instruction and called `cron_manage` with action `note`, and each call failed with `cron job note "<name>" was not approved (unavailable); nothing changed`. With `requireApproval` on, every gated `cron_manage` action asks the approval service, and an unattended cron Session has no approver, so the request resolves `unavailable`. The jobs lost the notes that let the next run continue instead of repeating.

## Decision

`launch.ts` keeps a module-private `WeakMap<Agent, string>` from each live run's Agent to the job that fired it. The job runner registers the entry with `registerCronRunJob` when the run's Session opens and removes it when the turn settles, beside the existing approval route; `cronRunJobName(agent)` reads it. The package entry exports neither function, so only the runner grants the association, and it rests on Agent object identity rather than any model-supplied text.

`cron_manage` action `note` skips approval when `cronRunJobName(exec.agent)` equals the requested job name. The registry still applies the `notesMaxChars` cap before writing, and a saved self-note logs `dsh-cron: job "<name>" updated its continuity notes (<n> chars)` at info. Notes on any other job, notes after the run settles, subagent children of the run, and every other action keep the approval requirement. The tool description now says that a job may replace its own notes during its run.

## Alternatives considered

**Match the Session id prefix.** Run Session ids are `cron-<name>-<uuid>`, but a prefix test is string matching that a job name containing another job's prefix could satisfy, and it would also accept a resumed or copied Session after the run ended.

**Carry the job name in the approval route.** The approval route is a public seam other packages register in tests; storing the self-note authority there would let any caller of that seam grant it.

**Turn off `requireApproval` for cron deployments.** That would also ungate create, update, delete, resume, and run_now.

## Consequences

An unattended run can rewrite only its own job's notes, bounded by `notesMaxChars`. Tests cover the association's lifetime across a run, an own-job note without approval within and over the cap, a refused note after the run, another job's note and a different action from a run still asking approval, and an `unavailable` outcome. The tool description change refreshed the owner-local `cron-manage.schema.json` and the recorded tool-schema snapshots.
