# Agent Note: Native weekly fantasy reports as research workflows

Status: implemented

English | [中文](2026-09-27-native-fantasy-weekly-reports.zh.md)

## Problem

Beardy's weekly fantasy reports for two household teams ran in an external Python service that read hand-typed rosters, launched research through a remote API, and handed rendered text back to the Discord gateway through files. The rosters drifted from Yahoo, the reports' model calls and evidence lived outside the harness logs, and the service's safeguards (roster-first sources, name admission, literal quotes, lineup checks, anchored review, bounded repair, publication gating) existed only in that service. The harness now reads Yahoo directly and runs durable research, so the reports need a native path that keeps those safeguards and logs every model call.

## Decision

`dsh-fantasy-reports` schedules three reports per configured team and runs each one as a consumer workflow of `ctx.research`. The research Service Definition gains `ResearchWorkflow`: a consumer passes a named, versioned procedure to `start`, and the provider records the name, prompt version, and deadlines in `research/started`, executes the procedure with logged tool-free stages and the same ledger writes as its general engine, and commits the resolved report as the completed result. The research packages stay domain-free; the fantasy procedure, its bounds, and its prompts belong to the fantasy consumer.

Yahoo is the authority for the roster, eligible positions, current slots, statuses, bye weeks, league slots, scoring, matchups, and projections. Web pages are admitted only when they name the player they were fetched for, and inverse strength-of-schedule ordinals and FantasyPros rank headers are rewritten or removed before any model reads a page. Code checks every draft: literal quotes from pages that name the player, full roster coverage, and a lineup that fills the league's Yahoo starting slots with eligible players who are neither on bye nor listed unavailable. Structural failures get bounded repair patches that do not spend factual reviews. Reviewer findings count only when they quote the draft and any cited evidence verbatim; after the last review a wrong-team, schedule, or season finding withholds the report, and other findings are repaired once more and disclosed. Code renders the accepted draft, so no model rewrites approved advice.

Delivery uses the scheduler's `cron/run-finished` handoff into the Discord gateway's durable outbox. A withheld or failed report sends a failure notice that endorses no advice. Runs use profile-scoped research ownership and a stable caller Session per team, so earlier completed reports become comparison context and remain readable through `deep_research`. Shadow mode routes every report and notice to one configured channel with a team label for a cutover week beside the old service.

## Alternatives considered

- **Put the fantasy engine inside the local research provider** — rejected because the general provider would depend on the fantasy service and carry fantasy configuration, and the research definition would import fantasy types.
- **Run the report as an ordinary cron Agent turn with the fantasy and web tools** — rejected because an open-ended tool loop cannot enforce roster-first coverage, literal quotes, lineup legality, or a review gate before delivery.
- **Keep the external service and only sync its rosters from Yahoo** — rejected because its model calls, sources, and reviews would still sit outside the harness logs and its safeguards would stay duplicated outside the harness.
- **Resolve opponents and kickoffs from a separate NFL schedule feed** — deferred; Yahoo bye weeks and statuses already let code refuse starters without a game, and opponent claims remain review-checked against cited pages.

## Consequences

Every report is an ordinary research run whose stages, sources, admission decisions, draft, and reviews are reconstructable from its Sessions and evidence file, and Beardy can reopen any report by ID. The research definition has a stable extension point for other procedures that need fixed coverage and gating. Reports cost more model calls than the general engine per run, bounded by the review and repair limits. A run interrupted by a restart is not retried for its slot, and a report whose delivery handoff keeps failing stays only in research history. Opponent and kickoff facts remain source-derived rather than code-checked.
