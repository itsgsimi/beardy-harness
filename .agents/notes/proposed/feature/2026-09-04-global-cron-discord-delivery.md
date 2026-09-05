# Agent Note: Global unattended cron with Discord delivery

Status: proposed

## Goal

Run scheduled agent work globally and unattended, without a live user or an open Session. The first job is a morning brief: Beardy runs headlessly on a cron schedule, summarizes RSS feeds grouped by category, adds the day's weather forecast plus the rest of the week, and posts the result to a Discord channel.

Acceptance for the first milestone: with `dsh --profile beardy` running and no user present, the brief appears in the configured Discord channel at the scheduled time, and its run is reconstructable from a Session log reachable through Beardy session search.

## Scope

In scope: a host-scoped tick runtime; cron-expression schedules declared in `cordis.yml`; unattended Session creation for one firing; one outbound Discord message tool; beardy bundle wiring for the morning-brief job.

Out of scope, deliberately deferred: user-editable durable job state with a Client management UI (the stated future state; requires its own persistence decision, see Rejected alternatives); RSS parsing as a dedicated tool; other delivery channels; job chaining equivalent to Hermes `context_from`; per-job skill or workdir overrides; catch-up replay policy beyond skip-when-stale.

## Relationship to existing notes

This note proposes rather than ships, so it supersedes nothing yet. Before the implementing PR, run the supersession check that `.agents/notes/AGENTS.md` requires and archive any triplet this change makes obsolete.

Two implemented notes are adjacent and must be read before implementing. [Background job completion wakes an idle owner](../../implemented/feature/2026-08-11-background-job-completion-wakes-an-idle-owner.md) solves a similar-looking problem from the opposite direction: it resumes an already-live Agent when an external process finishes, whereas this note starts work that no Agent is waiting on. [Bounded fixed-rate schedule](../../implemented/simplification/2026-08-09-bounded-fixed-rate-schedule.md) owns the interval semantics that `dsh-schedule` kept and that cron expressions here deliberately do not reuse. [Beardy profile foundation](../../implemented/feature/2026-08-29-beardy-profile-foundation.md) owns the bundle this note patches, including the limitation line it removes.

## Verified current state

These facts were confirmed by reading source in this workspace on 2026-09-04. Re-verify anything older than a week before relying on a line number.

### Scheduling that already exists, and why it does not fit

`@deepseek-ai/dsh-schedule` at `packages/schedule/schedule/` is a complete, shipped capability: "Agent-scoped durable after, at, and fixed-rate reminders over the session event log." It is registered in `tsconfig.host.json` (`{ "path": "./packages/schedule/schedule" }`) and path-mapped in `tsconfig.base.json`. Its three agent-scoped tools are `schedule_create`, `schedule_delete`, and `schedule_list` in `packages/schedule/schedule/src/tools.ts`. Rule math lives in `packages/schedule/schedule/src/domain.ts` (`resolveEveryOccurrence`, `createAtScheduleRecord`, `createEveryScheduleRecord`, `canonicalizeTimeZone`, `foldScheduleEvents`). It has seven spec files under `packages/schedule/schedule/tests/`, an e2e at `apps/web/tests/schedule-after.e2e.ts`, a user guide at `docs/user/guide/schedule.md`, and three notes: [durable session-local reminders](../../implemented/feature/2026-08-05-durable-web-schedule.md), [conversational delivery](../../implemented/simplification/2026-08-09-conversational-schedule-delivery.md), and [explicit schedule time zone](../../implemented/simplification/2026-08-09-explicit-schedule-time-zone.md).

It cannot serve this goal, and that is by design rather than an oversight. `packages/schedule/AGENTS.md` states that runtime owners "do not scan persisted Sessions, adopt already-published roots, wake cold Sessions, register global tools, or delete durable records during teardown," and that the owning Session's `schedule/change` stream is the only durable state. Delivery is `followup()` into the same Session once that Agent is fully idle, with a `session-local` disclosure and no external notification while cold. Rules are `after_seconds`, `at`, and `every_seconds` (minimum 300); there are no cron expressions — `grep -c cron packages/schedule/schedule/src/domain.ts` returns zero.

`packages/bundle/beardy/README.md` already records the gap as a known limitation: "**No cross-session scheduler** — the existing session-local schedule remains the only scheduled-reminder behavior." This proposal is the concrete use case against that limitation.

### Unattended agent execution already exists

`packages/webhook/` performs exactly the target shape of work today. `createWebhookSession()` at `packages/webhook/webhook/src/session.ts:119` resolves the permission preset and agent preset, calls `ctx.workspaceRegistry.create(path)`, creates the Agent through `ctx.agents.create({ sessionId, signal, meta, setup })` with the preset mounted in `setup`, attaches the Session to the Workspace, sets the permission preset, renames the Session, then delivers work with `handle.agent.followup(createUserMessage({ content, source }))`, and rolls back attach plus disposal on any failure. The runtime itself is fire-and-forget: `packages/webhook/webhook/src/index.ts` describes "Session creation is the only built-in action," and the GitHub adapter registers one route on `ctx.webServer` and returns 202 without waiting for rules or Sessions.

This is the reuse argument for the whole proposal: a scheduled run is a webhook whose trigger is a clock. No new identity system, no second persistence layer, no second Session-creation path.

### Process residency

`dsh --profile beardy` is a long-lived Web application; `packages/bundle/beardy/cordis.patch.yml` layers over `dsh-base` and `dsh-web-app`. The one-shot task runner is a different profile: `dsh --profile headless "task"`. Shipped applications are listed at `docs/architecture.md:43`. Residency for a tick loop is therefore satisfied by the profile the user already keeps running; no daemon, service manager, or OS crontab is required for v1.

### Outbound HTTP and secrets

DSH outbound HTTP uses undici with the policy half kept pure and network-free: `packages/web/web-fetch-http/src/network.ts:185` issues `fetch(url, { method: 'GET', redirect: 'manual', headers, signal, dispatcher })`, and `packages/web/web-fetch-http/src/policy.ts` owns `parseFetchUrl`, `validateFetchUrl`, `WEB_FETCH_MAX_URL_LENGTH = 2048`, content-type classification, and charset decoding. The fetch provider is GET-only, so a Discord POST needs its own request path while still following the same discipline: explicit AbortSignal, bounded response body, validated URL.

Credentials resolve through `ctx.credentials.resolve(ref)`, which returns `{ value, source }` or `undefined`, with `describe(ref)` for configuration state without the value. Root `.env` is gitignored (`.gitignore:2`). No RSS capability exists anywhere in `packages/`. There is no weather tool in this repository; `get_weather` appears only as a fixture name in `packages/llm/llm-pi-ai/tests/`, so it must not be assumed available to a headless run.

### Message sources and events are extensible without touching core

`SessionEventMap` is merge-extensible and `packages/core/session/src/index.ts:181` states "plugin-owned events carry no core message." Precedent for merging from a package: `packages/plan/plan-mode/src/index.ts:47` and `packages/todo/tool-todo/src/types.ts:29`. `MessageSourceMap` is likewise merge-extensible (`packages/skill/skill/src/index.ts:156`, `packages/api/session-controller/src/types.ts:380`), and a generic source of `{ kind: 'plugin', plugin: <name>, form: 'notice', summary }` is already used at `packages/plan/plan-mode/src/index.ts:509`. Use that existing source kind for scheduled runs; no core change is needed.

Package-merged session events stay out of the SDK projections: a repository-wide search for `todo/write` finds nothing in `packages/sdk`, `packages/python`, or `python/`. The same-PR dual-SDK obligation applies to changes in the core loop and core `SessionEventMap`, not to package merges.

## Decisions

**A separate package group, not an extension of `packages/schedule/`.** A host-scoped recurring runner directly contradicts the rules that subtree carries for itself. Putting it there would mean either breaking those rules or diluting them with exceptions, and both are worse than a new group. Proposed layout: `packages/cron/cron/` for `@deepseek-ai/dsh-cron`, and `packages/discord/tool-discord/` for `@deepseek-ai/dsh-tool-discord`. Per the naming table in [adding a package](../../../../docs/cookbook/adding-a-package.md), the tick component owns dispatch, cancellation, and operation lifecycle, so its role is `Runtime` with a singular `ctx` key (`cron`).

**Job definitions come from `cordis.yml`, not from runtime mutation.** This is what keeps the persistence objection answered: deployment-owned config is the job set, so v1 adds no durable state at all. Consequence to state plainly in the README limitations section: jobs cannot be created or edited while the process runs, and a change requires a config edit plus restart.

**Cron expressions via `croner` rather than a hand-rolled parser.** The repository prefers maintained dependencies when they genuinely delete owned code and tests; `croner` removes five-field parsing, step and range handling, and daylight-saving transition math, all of which are defect-prone here. Hermes reached the same conclusion with `croniter`, which it promotes to a core dependency. Operational caution: adding a dependency requires a root `pnpm install`, which rewrites `node_modules` under any running harness process; do it deliberately, not as a side effect of another command.

**Delivery is an agent-callable tool, not a decoupled delivery queue.** Hermes separates `delivery_queue.py` and `scheduler_delivery.py` from execution because it fans out to multiple messaging platforms and must survive restarts mid-delivery. One channel does not need that. With `discord_send` as a tool, the brief's own run performs delivery, so failures land in the Session log where the model can observe and retry them, and the cron package carries no delivery concern. The tradeoff accepted: delivery is not retried by the harness if the Agent never calls the tool.

**No Discord SDK.** Hermes' `tools/discord_tool.py` (646 lines) imports no Discord library; it uses `urllib.request` against `https://discord.com/api/v10`. `discord.js` and `@discordjs/rest` are gateway-and-websocket frameworks whose transport, sharding, and rate-limit caches buy nothing for a single POST while adding a large dependency tree. `discord-api-types` is types-only with no runtime cost and is the only SDK-shaped option worth reconsidering, and only if payload typing starts to matter beyond a `content` field.

**Borrow from Hermes, selectively.** Take the byte-capped response read (`_read_limited_response_body`), the token-from-secret-scope pattern that maps onto `ctx.credentials.resolve`, and 429 handling with `Retry-After`. Leave behind capability detection, its on-disk cache keyed by a token hash, and the guild, member, and message listing operations: those form an interactive Discord operator tool, and this proposal has no consumer for them.

## Safety requirements

The brief feeds attacker-writable RSS content to an agent that can post outside the process, and Beardy carries the full Creator-mode roster including harness source modification. Two controls are mandatory rather than optional.

Send every Discord message with `allowed_mentions: { parse: [] }`, so a mention token planted in feed content cannot ping the channel. Reject or strip `@everyone` and `@here` regardless of what the model composes.

Run scheduled jobs under a restricted preset that grants web fetch and Discord send only, with no source editing and no command execution. `createWebhookSession` already accepts `permissionPreset` and `agentPreset` per request, so this is configuration, not new machinery. Do not mount the cron job on the default Beardy preset.

The Discord bot token must never appear in tracked files, config values, tests, fixtures, logs, or documentation. It lives in root `.env` as `DSH_DISCORD_BOT_TOKEN` and reaches the tool only through a credentials ref. The channel id is ordinary configuration, not a secret; the value in use during this proposal was `1478276183543119914`, and it should be confirmed with the user rather than trusted from this note. A token pasted into a chat transcript should be rotated and scoped to Send Messages in that one channel.

## Implementation increments

Each increment is independently verifiable; do not start the next before the previous one passes its own checks.

### Increment 1 — `@deepseek-ai/dsh-tool-discord`

Prove delivery by hand before any clock exists. Files: `packages/discord/tool-discord/package.json`, `tsconfig.json`, `src/index.ts`, `src/types.ts` (types only, plus the `declare module '@deepseek-ai/cordis'` merge if a service key is introduced), `src/invariant.ts`, `README.md`, `README.zh.md`, `README.i18n.yaml`, `tests/discord-send.spec.ts`.

The tool is `discord_send`, registered through `ctx.tools.register(defineTool({ ... }))` following `packages/todo/tool-todo/src/index.ts:149` for shape, including `output.schema`, `output.render`, and `presentCall`. Copy the plugin export discipline from `packages/webhook/webhook/src/index.ts`: a service package default-exports its `Service` subclass with `super(ctx, 'key')` and `static inject`, while a function plugin named-exports `name`, `inject`, `Config`, and `apply`; mixing the two makes the Loader discard the namespace.

Requirements to implement and test: token resolved via `ctx.credentials.resolve` with a clear failure when unconfigured; channel id from validated `Config`, never hardcoded; POST to `https://discord.com/api/v10/channels/{id}/messages` over undici with an AbortSignal tied to registration lifetime; chunking at Discord's 2000-character content limit, split on markdown boundaries rather than mid-token, with the complete emitted payload measured including any wrapper or metadata; `allowed_mentions: { parse: [] }`; 429 responses honored via `Retry-After` with a bounded retry count and no unbounded loop; response bodies read under an explicit byte cap; every registration disposed through `ctx.effect()` so the HMR-safety disposal test passes.

Tests: unit coverage for chunking (short, exactly-at-limit, oversized single chunk, multibyte content), token-absent failure, non-2xx mapping, and 429 handling against a stubbed transport; plus the product-visible REAL-composition test required by `docs/testing.md` that boots a `cordis.yml` through the Loader and asserts the tool reaches a model request.

### Increment 2 — `@deepseek-ai/dsh-cron`

Files: `packages/cron/cron/package.json`, `tsconfig.json`, `src/index.ts`, `src/types.ts`, `src/parse.ts` or a thin wrapper over `croner`, `src/runtime.ts`, `src/invariant.ts`, bilingual READMEs, and specs under `tests/` for schedule math, the tick loop, single-flight behavior, and teardown.

`Config` carries the job list, and every deployment-varying number is a validated config field: tick interval, stale-run grace window, timezone default, and whether cron is enabled at all. No `DEFAULT_*` constant may stand in for configurability, per the repository rule against hardcoded tunables. Each job record holds an id, a cron expression, the prompt, the agent preset, the permission preset, and an optional workspace path.

The runtime owns one timer registered through `ctx.effect()` so stop and update remove it; on each tick it computes due jobs, skips runs older than the grace window instead of replaying a backlog, guards against overlapping firings of the same job with a single-flight set, and starts work through the existing Session-creation path rather than inventing one. Residency: refuse to arm under a profile that exits after one task, and fail loud at load rather than silently arming nothing.

Because a fired run reaches a model request, model-visible state must be reconstructable from the log. Record each firing with a merged package-owned event following `packages/plan/plan-mode/src/index.ts:47`, and use `{ kind: 'plugin', plugin: 'cron', form: 'notice', summary }` as the message source. Keep rule math pure and deterministic so tests supply explicit samples or fake timers; do not add a production clock service, which is also what `packages/schedule/AGENTS.md` requires of its own math.

### Increment 3 — wiring and the morning brief

Add both packages to `tsconfig.base.json` paths for the new groups and one `references` entry each in `tsconfig.host.json`; a package belongs to exactly one aggregate. Mount both in `packages/bundle/beardy/cordis.patch.yml`, define the brief job at `0 7 * * *`, point it at the restricted preset, and put the RSS URLs grouped by category plus the weather endpoint in the job prompt so categories are configuration rather than prose buried in a system prompt. Update `packages/bundle/beardy/README.md` to remove the now-stale "No cross-session scheduler" limitation line and record what replaced it. Add the Chinese README pair and the `.i18n.yaml` companions, then run the documentation gates; pairing is user-invoked work under `dsh-translate-docs`, so flag it rather than machine-translating silently.

## Verification

Per increment: `pnpm install` when dependencies change, then `pnpm run constraints && pnpm run typecheck && pnpm run lint`, then `pnpm run build && pnpm run hygiene`. Documentation changes need `pnpm run doc-sync`; new packages need behavior tests against the CI coverage gate, which is per-file 100% on `packages/*/*/src` and is measured by `pnpm run test:coverage`, not `pnpm run test`. Follow `docs/testing.md` for the REAL-composition and snapshot requirements. Choose evidence that matches the surface; do not rehearse the full suite.

## Traps already encountered

A truncated search caused a wrong conclusion in the session that produced this note: a repository-wide grep piped through `head -40` returned results in traversal order, silently omitted `packages/schedule/`, and its absence was then reported as fact. Absence claims need an untruncated or path-scoped search.

Other traps: `dsh --profile beardy` is not a one-shot runner; the subtree rules under `packages/schedule/AGENTS.md` forbid global scheduling inside that group; service-class default exports and function-plugin named exports must not be mixed in one package; every package owns an `./invariant` entry, and an unexplained empty fails `verify-package-invariants`; `src/types.ts` holds types only; tests live at package level under `tests/`, never in `src/__tests__/`.

## Open questions for the user

Confirm the target channel id. Confirm whether jobs staying config-only until a later durable-state proposal is acceptable, since it means editing `cordis.yml` and restarting to change the schedule. Decide whether the brief should also land as a searchable Session beyond posting to Discord, which changes whether the run's Workspace path needs pinning for session search to index it. Confirm the RSS feed list and its categories, and confirm the weather source; no weather tool exists in this repository, so v1 drives an HTTP endpoint through web fetch.
