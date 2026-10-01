---
description: "Scheduled weekly Yahoo fantasy reports: live league data, a reviewed research run per report, and Discord delivery."
kind: "package-reference"
---

# @deepseek-ai/dsh-fantasy-reports

English | [中文](README.zh.md)

## Summary

Send each configured Yahoo team a weekly full report and Thursday and Sunday updates. Each report reads the live roster, league slots, scoring, matchup, injury statuses, and projections from `ctx.fantasy`, researches every rostered player on the web, and is written and reviewed by the model inside one durable research run. Only a report that passes the code checks and review policy reaches Discord; otherwise the team's channel receives a failure notice.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount a Fantasy provider such as [fantasy-yahoo](../fantasy-yahoo/README.md), the [local research provider](../../research/research-local/README.md) with `ownerScope: profile`, `ctx.web` search and fetch providers, and a `cron/run-finished` delivery listener for the targets you use: the Discord gateway for Discord channel ids, or signal-notices for `signal:group:<base64 id>` and `signal:number:<E.164>` targets. The plugin fails a fire with a notice when research ownership is not profile-scoped, because report history must outlive each run.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-fantasy-reports'
  config:
    timezone: America/Phoenix
    workspacePath: /home/user/.dsh/fantasy-reports
    teams:
      - id: googies
        name: The Googies
        teamKey: 470.l.809970.t.7
        channelId: '1472404859679670455'
        schedule: { full: '0 14 * * 3', thursday: '0 11 * * 4', sunday: '30 5 * * 0' }
```

`teams` has no default. Each team's league comes from its team key. Research, review, and delivery bounds have validated defaults; the [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-fantasy-reports) lists every field.

### Schedules and weeks

Each team has three cron expressions in `timezone`. Fires run one at a time, and a research run starts at least `minimumStartGapMs` (90 minutes by default) after the previous start. A fire resolves the Yahoo game week containing its local date; outside `firstWeek` through `lastWeek` it does nothing. A week and mode that already has a scheduled or catch-up run is skipped, so a repeated fire never sends a second report.

Each fire logs one line, `fantasy-reports: <team> <mode>[ catch-up| manual] <outcome>[: <reason>]`. A `published` or `redelivered` report logs at info; `skipped`, `withheld`, `failed`, and `undelivered` log at warn with their reason, so a journal that keeps only warnings still shows every fire that sent no report. A fire that is queued or running when the plugin stops logs `<team> <mode> abandoned because the plugin stopped` at warn and makes no further Yahoo, research, or delivery call.

### Restart catch-up

When the plugin starts, it revisits each team's latest slot at or before that moment once, if less than `catchUpWindowMs` (12 hours by default) has passed since the slot; `0` turns catch-up off. A Sunday slot uses the tighter `sundayCatchUpWindowMs` (2 hours by default), measured from that team's Sunday slot, so a caught-up Sunday report still arrives before kickoff; the window is checked again after start spacing. The research history decides the rest: a slot with no run, or whose only runs were interrupted, gets one catch-up run; a completed report is handed to delivery again under its original fire time, which the listener deduplicates, so a report whose earlier handoff failed still reaches Discord; a slot with a failed, withheld, cancelled, or earlier catch-up run is left alone. Earlier slots of the week are superseded by the latest one and never caught up.

### On-demand reports

Set `commandPresets` to the Agent presets whose humans may run `/fantasy-report <team> [full|thursday|sunday]`; the mode defaults to `full`. The command is human-only, so its input never reaches a model, and the Discord gateway lists it with the preset's other commands. A team's `commandPresets`, when present and non-empty, narrows who may request that team, for example one owner's lane to her own team; each entry must also be in the top-level list. With the default empty list the command is not registered.

```yaml
commandPresets: [beardy, beardy-mamabear]
teams:
  - id: googies
    # ...
  - id: lights
    # ...
    commandPresets: [beardy]
```

The request resolves the Yahoo week containing today's date in `timezone` and runs the same workflow as a scheduled report, tagged with trigger `manual`. It answers at once with `Started the full report for The Googies; it will post to the team's report channel when done.`, or names how many reports are ahead of it in the queue, and the report or its failure notice goes where that team's scheduled reports go, including the shadow channel. An unknown team returns an error that lists the team ids the preset may request, and a date outside `firstWeek` through `lastWeek` fails with a notice. A manual run starts even when its week and mode already have runs, and scheduled fires and catch-up never count manual runs. It shares the queue with scheduled fires, so it never overlaps another report, but it neither waits for nor resets `minimumStartGapMs`.

### Delivery, notices, and shadow mode

A completed report is handed to `cron/run-finished` with outcome `answered` and the team's `channelId`, and the durable outbox of that target's delivery owner posts it. A withheld report sends the code `FANTASY_REPORT_WITHHELD`; a Yahoo, research, or model failure sends `FANTASY_REPORT_FAILED`. Both notices endorse no advice. With `shadowChannelId` set, every report and notice goes only to that channel; reports start with a shadow label naming the team, and job names start with `shadow-`.

### History

Every run is linked from the team's caller Session `fantasy-reports-<id>`; after `workspacePath` changes, the team's caller becomes `fantasy-reports-<id>-<hash>`, where `<hash>` is the first 8 hex digits of the new path's SHA-256, and the earlier caller Session stays unchanged. Each run's query carries a `[fantasy-report:<team>:<season>:<week>:<mode>:<trigger>:<firedAt>]` tag, where the trigger is `scheduled`, `catch-up`, or `manual` and `firedAt` is the fire time in epoch milliseconds that delivery carries. A new report shows the writer up to `historyReports` earlier completed reports of the same team and season as comparison data. Beardy can read the same reports through `deep_research` `list` and `report`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin starts each report as a [research workflow](../../research/research/README.md): the provider records the workflow name and prompt version, and every model call is a logged, tool-free stage Session of the run. Writer, reviewer, and repair stages pass a JSON check built from the same parser that later reads the answer, so a prose or pseudo-tool-call answer receives one corrective turn in the same stage Session before the workflow's own repair or retry policy sees it; a failing corrective answer leaves the first answer to that policy.

1. **Yahoo facts.** The workflow reads the roster, each player's slot lock, and the matchup for the week, and checks the league, team, and week against the request. Roster players get short ids (`P1`, `P2`, ...).
2. **Sources.** Each player gets up to `searchesPerPlayer` queries and keeps up to `pagesPerPlayer` HTTPS pages outside `excludedHosts`. A page is admitted only when it names the player; a name too short to match admits the page. FantasyPros rank and projection headers are removed, and strength-of-schedule ordinals such as "30th easiest opponent" become plain difficulty words before any model reads the page. Literal passages around roster names bound each page. Every search, fetch failure, and admission decision enters the run, and each admitted page's exact model-visible text becomes a source attachment.
3. **Draft.** The writer returns JSON: one row per player with 1–2 quoted facts, a lineup, actions, close decisions, and caveats.
4. **Code checks.** Quotes must be 12–300 character excerpts of a cited page that names the player. The lineup must fill the league's starting slots with eligible players, with no player on bye or listed out, injured reserve, suspended, or not active; every starter must be `START` or `CONDITIONAL`. A player whose slot Yahoo has locked because his game started stays where Yahoo shows him: a locked starter keeps his slot and is exempt from the availability check, and a locked bench player cannot start. Failures go to a structural repair patch, up to `maxStructuralRepairs` times, without spending a factual review. Before the checks, a `player` value in a players or lineup row that is not a roster id but equals exactly one roster player's name, ignoring case and whitespace, becomes that player's id, and an id written in another case or spacing becomes the id; an unknown or ambiguous name still fails as `not a roster id`. Patch rows are keyed by `player` like draft rows; a patch row may use `id` for `player` and `rationale` or `reasoning` for a missing `reason`, while a writer draft must use the writer fields. No alias supplies `facts`, so a patch row without quoted facts still fails.
5. **Review.** The reviewer returns findings that quote the draft verbatim and, for contradictions, quote a source or the Yahoo context verbatim. Unanchored, wording-only, no-fix, and repeated findings are discarded and kept in the evidence. A repair patch follows each review with findings. After `maxReviews` reviews, a wrong-team, schedule, or season finding withholds the report; other findings are repaired once more and the report discloses that they were not reviewed again.
6. **Report.** Code renders the accepted draft: actions, changes from the current Yahoo lineup, the lineup with the players Yahoo has locked, close calls, every player with Yahoo slot and lock, status, bye, and projection, next checks, and cited sources as preview-free links. No model rewrites the accepted advice. The evidence file keeps the Yahoo snapshot, sources, draft, and every review.

No invariant companion is published: timers, queue order, and delivery attempts are observable only through this plugin's own log lines, and the research provider owns every durable relationship.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Timers, restart catch-up, the on-demand command, week resolution, history, notices, and delivery |
| [`src/workflow.ts`](src/workflow.ts) | Sources, stages, and the publication policy |
| [`src/draft.ts`](src/draft.ts) | Draft parsing, code checks, patches, and review filtering |
| [`src/lineup.ts`](src/lineup.ts) | Yahoo slot legality, slot locks, and lineup changes |
| [`src/sources.ts`](src/sources.ts) | Name admission, page cleaning, and passages |
| [`src/render.ts`](src/render.ts) | Report Markdown |
| [`src/prompts.ts`](src/prompts.ts) | Versioned stage instructions and the stage system prompt |
| [`src/config.ts`](src/config.ts) | Configuration validation |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Fantasy subsystem](../../../docs/subsystems/fantasy.md) — Yahoo reads and the weekly report path.
- [Research subsystem](../../../docs/subsystems/research.md) — durable runs and consumer workflows.
- [Weekly report decision](../../../.agents/notes/implemented/feature/2026-09-27-native-fantasy-weekly-reports.md) — why reports are research workflows and which Odysseus safeguards carried over.
- [Locks and catch-up decision](../../../.agents/notes/implemented/feature/2026-09-27-fantasy-report-locks-and-catch-up.md) — why locked slots are code-checked and how a restart catches up a missed slot without a second send.
- [Repair and on-demand decision](../../../.agents/notes/implemented/bug-fix/2026-09-30-fantasy-reports-repair-and-on-demand.md) — the `id` patch alias, warn-level fire outcomes, and the `/fantasy-report` command.
- [Player names decision](../../../.agents/notes/implemented/bug-fix/2026-09-30-fantasy-player-names.md) — why names map to roster ids, which patch aliases are accepted, and why repair prompts restate the row format.

-----

<a id="model-experience"></a>
## Model Experience

### Weekly report stages

#### What the model sees

Each stage is a new tool-free Session under the report's research run, with one task message after the stage system prompt and no runtime context. The system prompt is `You are one stage of a fantasy football weekly report workflow: the writer, reviewer, or repair step that the user message describes. You have no tools and cannot search, browse, look anything up, or run commands, so never write a tool call; work only from the data in the user message. Every answer is exactly one JSON object in the format the message asks for, with no prose, Markdown, or code fences around it.` An answer that fails its stage's JSON check is followed by `Your reply was not the requested JSON. Reply with only the JSON object in the requested format.` The writer message holds the versioned instructions, the Yahoo context as JSON (team, week, report time, starting and reserve slots, scoring values, matchup projections, and each player's id, NFL team, positions, Yahoo slot and whether it is locked, status, injury note, bye, and projection), earlier reports marked as comparison data, and the admitted page passages marked as untrusted data. Reviewer messages hold the Yahoo context, the cited passages, and the draft. Repair messages restate the writer's players row format and the lineup entry format, then hold the errors or findings, the affected rows, the other sections, and the affected passages.

#### Token effect

A writer message carries at most `promptSourceChars` characters of passages (120,000 by default) plus the roster context; reviews and repairs send only cited or affected passages. Output is bounded by `writerMaxTokens`, `reviewerMaxTokens`, and `repairMaxTokens`.

#### KV Cache effect

Every stage is a fresh Session, so no stage reuses another's prefix; a corrective turn extends its own stage's prefix. Reports of the same team and week share the instruction prefix but differ from the Yahoo context on.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Opponents and kickoff times come only from cited pages; the report has no code-checked schedule source, because Yahoo's roster and player reads carry bye weeks and slot locks but no NFL opponent or kickoff time.
- A slot lock is read when the report runs, so a player whose game starts later is not yet locked; the report still says to check lineup locks before changing Yahoo, and it never executes changes.
- Catch-up runs only when the plugin starts and only for each team's latest slot. A slot interrupted again during its catch-up, a completed report whose delivery fails after the window closes, and a completed report whose tag has no fire time stay only in research history.
- Yahoo projections appear only when the provider returns them for roster players.
- Only player rows of a repair patch accept the `id` alias; repair prompts show the current lineup with `player` keys, so lineup rows keep requiring `player`.
- `/fantasy-report` always reports the week containing today's date; it takes no week argument.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The snapshot scenario `snapshots/session/fantasy-report` replays one shadow-mode report on anonymized Yahoo captures, including one anchored finding and its repair; the delivered Discord text is its workspace oracle.

</details>
