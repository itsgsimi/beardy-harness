# Agent Note: Fantasy report repair keys, fire visibility, and on-demand reports

Status: implemented

English | [中文](2026-09-30-fantasy-reports-repair-and-on-demand.zh.md)

## Problem

On 2026-09-30 the Googies full report was withheld three minutes after its 6:00 PM fire: the factual repair stage returned `{"players":[{"id":"P14","recommendation":"START",...}]}`, and the patch parser rejected it with `players[0].player must be a string`. Both repair prompts asked for rows "complete with the same schema and id", which invites an `id` key, while draft rows are keyed by `player`.

The Lights full report, scheduled 90 minutes later on the same day, left no research run, stage Session, or failure notice. Fire outcomes were logged at info, which the deployment's log exporter drops, so a skipped fire was invisible. A fire that was queued or running when the plugin's effect was disposed ended without any log line, because the queue swallowed every error once disposal had started; a fire still queued at that moment would also make Yahoo calls against the stopping plugin before failing quietly. There was also no way to rerun a team's report after a failure: a scheduled fire skips a week and mode that already has a run.

## Decision

Both repair prompts now name the key and show an example row, `{"player":"P14","recommendation":"START",...}`, and the prompt version becomes `fantasy-weekly-v3`. The patch parser accepts `id` as an alias for `player` in patch rows only; a row that has `player` keeps it, and the writer draft must still use `player`, so the alias cannot mask a draft that names no player. Lineup rows keep requiring `player`, because the repair prompts show the current lineup with `player` keys.

Every fire outcome other than `published` and `redelivered` now logs at warn with its reason. A fire that disposal abandons logs `abandoned because the plugin stopped` at warn, and a queued fire checks the disposal signal before it starts any work.

A human command, `/fantasy-report <team> [full|thursday|sunday]`, enqueues a report run tagged with trigger `manual` for the Yahoo week containing today's date and answers at once. It is registered only when `commandPresets` names at least one Agent preset, the handler admits only Sessions whose recorded preset is listed, and a team's optional `commandPresets` narrows who may request that team, which is enough to give one owner's lane only her own team. A manual run ignores earlier runs of its week and mode, and scheduled and catch-up slot checks ignore manual runs, so a rerun never suppresses or duplicates the scheduled report of that slot. A date outside the report weeks fails with a notice instead of a skip, because the requester was already told the run started. Manual runs share the fire queue, so no two reports overlap, but they neither wait for nor reset `minimumStartGapMs`, because a human waiting for a rerun should not wait up to 90 minutes.

## Lights investigation

A test mounts two teams with full reports 90 minutes apart on real croner timers under fake timers, with the default `minimumStartGapMs` of 5,400,000, and withholds the first team's run: the second fire starts its run on time and publishes. Croner's overlap protection cannot drop a fire, because the timer callback only enqueues and returns. Start spacing is measured from the first run's start, which preceded the second fire by just under 90 minutes, so the wait is at most seconds. The failed first fire returned normally through its notice, so the queue was not blocked.

The remaining paths that leave no run and no notice are a `skipped` outcome (a week outside `firstWeek` through `lastWeek`, or an earlier run of the same week and mode) and disposal of the plugin's effect, for example after an injected service is removed or reloaded. Neither was visible in the deployment's journal; both now log at warn. The live root cause was not established from the available evidence.

## Alternatives considered

- **Accept `id` in every row parser** — rejected because a writer draft that omits `player` is a structural error the repair loop should see, and the writer prompt never mentions `id`.
- **Let a manual request bypass the queue** — rejected because two concurrent report runs would contend for the single model server and break the one-at-a-time guarantee the schedules rely on.
- **Space manual runs like scheduled ones** — rejected because the acknowledgement promises a prompt run; the shared queue already prevents overlap.
- **Count manual runs in the scheduled slot check** — rejected because a failed or early manual run would then silently suppress the scheduled report.

## Consequences

A repair patch keyed by `id` is applied instead of withholding the report. A deployment that keeps only warnings sees every skipped, withheld, failed, undelivered, and abandoned fire. A configured human can rerun a team's report from Discord, and the result or a failure notice goes where scheduled reports go, including the shadow channel. `/fantasy-report` always reports the current week.
