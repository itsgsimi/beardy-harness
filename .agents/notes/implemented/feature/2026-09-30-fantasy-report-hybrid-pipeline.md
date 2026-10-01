# Agent Note: Fantasy report hybrid pipeline

Status: implemented

English | [中文](2026-09-30-fantasy-report-hybrid-pipeline.zh.md)

## Problem

The weekly fantasy report asked one writer stage for a large rigid JSON document: every player row with quoted facts, the lineup, actions, close decisions, and caveats, followed by reviewer and repair stages that patched it. Live runs kept failing on format drift: a reviewer wrote pseudo tool calls, a repair keyed rows by `id` instead of `player`, a writer keyed rows by player name instead of `P1`, and repairs invented fields. Any one drift withheld the whole report, although most of the document was facts and arithmetic that code already knew.

## Decision

Code owns everything deterministic and the model makes only small judgments, each validated on its own. Code reads the Yahoo roster, slots, matchup, and free agents; gathers news with name admission and cuts verbatim excerpts; searches for the legal lineup with the highest summed Yahoo projection under flex eligibility, availability, and slot locks; flags close calls; shortlists free agents at weak positions; and renders the Markdown report. Model stages answer fixed shapes: per-player `START`, `SIT`, `FLEX`, or `HOLD` calls with a short reason and cited source ids in batches of `playersPerStage`; one comparison per flagged pair; waiver picks among shortlisted ids; a reason check; and a 3 to 5 sentence summary.

Validation is per item. An invalid or missing player is asked again once in a request for just those ids and otherwise keeps the code default with a plain Yahoo reason; code applies model calls only as legal swaps and rejects starts of unavailable players and moves of locked players; an invalid comparison or pick is omitted; an unusable summary is replaced by a code summary; a flagged reason becomes a plain Yahoo reason. The report lists every degraded part in its caveats and publishes unless the Yahoo facts fail or no model stage answers usably. Every model call stays a logged stage Session through the research workflow runner, with the existing stage system prompt mechanism and corrective JSON turn; the prompt version is `fantasy-weekly-v5`. The writer, reviewer, and repair stages, their prompts, and their configuration fields are removed; report tags and run history keep their formats, so earlier runs still parse.

## Alternatives considered

- **Keep the monolithic draft and tolerate more drift** — rejected because each new alias or repair rule fixed one observed failure while any other drift still withheld the whole report.
- **Let the model choose the lineup and have code check it** — rejected because the legal projection-maximizing lineup is a small search that code can compute exactly; the model's useful contribution is the judgment to deviate, which code can then accept or reject per swap.
- **Withhold when the reason check flags reasons** — rejected because a flagged reason is replaced by a plain Yahoo reason; withholding would again let one bad item block the report.
- **Ask for structured output through the LLM seam** — deferred; the LLM call configuration has no response-format field, and small fixed-choice answers parsed per item already remove the failure mode.

## Consequences

One bad answer now degrades one row, pair, pick, or the summary instead of the report. The report is shorter and more uniform: calls, close calls, and waiver ideas instead of free-form actions and decisions. The anonymized Yahoo roster captures carry no per-player projections, so until the provider requests projected stats the lineup search keeps current Yahoo starters except unavailable ones and close calls come only from uncertain starters. Waiver candidates have only Yahoo facts. The earlier notes on the [native weekly reports](2026-09-27-native-fantasy-weekly-reports.md) and the [repair `id` alias](../bug-fix/2026-09-30-fantasy-reports-repair-and-on-demand.md) describe the replaced writer, review, and repair policy.
