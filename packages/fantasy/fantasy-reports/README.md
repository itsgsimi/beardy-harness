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

Mount a Fantasy provider such as [fantasy-yahoo](../fantasy-yahoo/README.md), the [local research provider](../../research/research-local/README.md) with `ownerScope: profile`, `ctx.web` search and fetch providers, and a `cron/run-finished` delivery listener such as the Discord gateway. The plugin fails a fire with a notice when research ownership is not profile-scoped, because report history must outlive each run.

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

Each team has three cron expressions in `timezone`. Fires run one at a time, and a research run starts at least `minimumStartGapMs` (90 minutes by default) after the previous start. A fire resolves the Yahoo game week containing its local date; outside `firstWeek` through `lastWeek` it does nothing. A week and mode that already has a run is skipped, so a repeated fire never sends a second report.

### Delivery, notices, and shadow mode

A completed report is handed to `cron/run-finished` with outcome `answered` and the team's `channelId`, and the gateway's durable outbox posts it. A withheld report sends the code `FANTASY_REPORT_WITHHELD`; a Yahoo, research, or model failure sends `FANTASY_REPORT_FAILED`. Both notices endorse no advice. With `shadowChannelId` set, every report and notice goes only to that channel; reports start with a shadow label naming the team, and job names start with `shadow-`.

### History

Every run is linked from the team's caller Session `fantasy-reports-<id>`, and its query carries a `[fantasy-report:<team>:<season>:<week>:<mode>]` tag. A new report shows the writer up to `historyReports` earlier completed reports of the same team and season as comparison data. Beardy can read the same reports through `deep_research` `list` and `report`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin starts each report as a [research workflow](../../research/research/README.md): the provider records the workflow name and prompt version, and every model call is a logged, tool-free stage Session of the run.

1. **Yahoo facts.** The workflow reads the roster and matchup for the week and checks the league, team, and week against the request. Roster players get short ids (`P1`, `P2`, ...).
2. **Sources.** Each player gets up to `searchesPerPlayer` queries and keeps up to `pagesPerPlayer` HTTPS pages outside `excludedHosts`. A page is admitted only when it names the player; a name too short to match admits the page. FantasyPros rank and projection headers are removed, and strength-of-schedule ordinals such as "30th easiest opponent" become plain difficulty words before any model reads the page. Literal passages around roster names bound each page. Every search, fetch failure, and admission decision enters the run, and each admitted page's exact model-visible text becomes a source attachment.
3. **Draft.** The writer returns JSON: one row per player with 1–2 quoted facts, a lineup, actions, close decisions, and caveats.
4. **Code checks.** Quotes must be 12–300 character excerpts of a cited page that names the player. The lineup must fill the league's starting slots with eligible players, with no player on bye or listed out, injured reserve, suspended, or not active; every starter must be `START` or `CONDITIONAL`. Failures go to a structural repair patch, up to `maxStructuralRepairs` times, without spending a factual review.
5. **Review.** The reviewer returns findings that quote the draft verbatim and, for contradictions, quote a source or the Yahoo context verbatim. Unanchored, wording-only, no-fix, and repeated findings are discarded and kept in the evidence. A repair patch follows each review with findings. After `maxReviews` reviews, a wrong-team, schedule, or season finding withholds the report; other findings are repaired once more and the report discloses that they were not reviewed again.
6. **Report.** Code renders the accepted draft: actions, changes from the current Yahoo lineup, the lineup, close calls, every player with Yahoo slot, status, bye, and projection, next checks, and cited sources as preview-free links. No model rewrites the accepted advice. The evidence file keeps the Yahoo snapshot, sources, draft, and every review.

No invariant companion is published: timers, queue order, and delivery attempts are observable only through this plugin's own log lines, and the research provider owns every durable relationship.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Timers, week resolution, history, notices, and delivery |
| [`src/workflow.ts`](src/workflow.ts) | Sources, stages, and the publication policy |
| [`src/draft.ts`](src/draft.ts) | Draft parsing, code checks, patches, and review filtering |
| [`src/lineup.ts`](src/lineup.ts) | Yahoo slot legality and lineup changes |
| [`src/sources.ts`](src/sources.ts) | Name admission, page cleaning, and passages |
| [`src/render.ts`](src/render.ts) | Report Markdown |
| [`src/prompts.ts`](src/prompts.ts) | Versioned stage instructions |
| [`src/config.ts`](src/config.ts) | Configuration validation |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Fantasy subsystem](../../../docs/subsystems/fantasy.md) — Yahoo reads and the weekly report path.
- [Research subsystem](../../../docs/subsystems/research.md) — durable runs and consumer workflows.
- [Weekly report decision](../../../.agents/notes/implemented/feature/2026-09-27-native-fantasy-weekly-reports.md) — why reports are research workflows and which Odysseus safeguards carried over.

-----

<a id="model-experience"></a>
## Model Experience

### Weekly report stages

#### What the model sees

Each stage is a new tool-free Session under the report's research run, with one task message after the stage system prompt and runtime context. The writer message holds the versioned instructions, the Yahoo context as JSON (team, week, report time, starting and reserve slots, scoring values, matchup projections, and each player's id, NFL team, positions, Yahoo slot, status, injury note, bye, and projection), earlier reports marked as comparison data, and the admitted page passages marked as untrusted data. Reviewer messages hold the Yahoo context, the cited passages, and the draft. Repair messages hold the errors or findings, the affected rows, the other sections, and the affected passages.

#### Token effect

A writer message carries at most `promptSourceChars` characters of passages (120,000 by default) plus the roster context; reviews and repairs send only cited or affected passages. Output is bounded by `writerMaxTokens`, `reviewerMaxTokens`, and `repairMaxTokens`.

#### KV Cache effect

Every stage is a fresh single-turn Session, so no stage reuses another's prefix. Reports of the same team and week share the instruction prefix but differ from the Yahoo context on.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Opponents and kickoff times come only from cited pages; the report has no code-checked schedule source.
- Lineup locks are not checked; the report states that it recommends and does not execute.
- A report interrupted by a restart is not retried for that week and mode, and a report whose delivery handoff fails after its attempts stays only in research history.
- Yahoo projections appear only when the provider returns them for roster players.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The snapshot scenario `snapshots/session/fantasy-report` replays one shadow-mode report on anonymized Yahoo captures, including one anchored finding and its repair; the delivered Discord text is its workspace oracle.

</details>
