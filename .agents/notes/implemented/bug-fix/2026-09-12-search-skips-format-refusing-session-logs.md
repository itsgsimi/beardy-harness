# Agent Note: Search skips format-refusing session logs

Status: implemented

English | [中文](2026-09-12-search-skips-format-refusing-session-logs.zh.md)

## Problem

A durable Session log can be listed and still be unreadable: `listArtifacts` in `session-persistence-jsonl` skips a header whose format chain refuses it, while the stored body may refuse migration for its own reason. Deployments that carry pre-V3 history therefore hold logs that no reader can interpret — v2-era logs rejected with `cannot safely transform unclassified message source`, and logs whose user-message source carries a member the frozen v2 validator does not admit, such as `frozenUserGlobalInstructions`.

SQLite index reconciliation cold-reads every listed persisted Session to build its live-preferred corpus. It treated any throw from that read as a storage failure, so one uninterpretable log surfaced `SESSION_QUERY_PERSISTENCE_FAILED` and the `session_search`, `session_event_search`, and `session_event_read` tools reported `session history storage is unavailable`. The message described the wrong thing: the store was healthy, the index opened, and every other Session in the process — across all workspaces that one shared index covers — was perfectly readable. Because a refused log can never be indexed, every later search re-attempted it and failed again, making the outage permanent rather than transient.

## Decision

`_observeStable` in `session-query-sqlite` catches `SessionFormatUnsupportedError` around each cold read and leaves that entry unloaded instead of propagating it. Reconciliation already selects only loaded entries for indexing, so a refused log is simply absent from the index while every other Session indexes normally; any other read failure still becomes `SESSION_QUERY_PERSISTENCE_FAILED`. Reads that target a known live Session never consult persistence, so that path is unchanged.

Search corpus and listing now agree: what the backend refuses to interpret is invisible to both, rather than fatal to one.

## Alternatives considered

**Move the offending directories out of the persistence root.** This restores search for one machine immediately and was available as an operator action, but it deletes history from every query view by hand and leaves the next deployment with pre-V3 logs equally broken.

**Admit `frozenUserGlobalInstructions` to the v2→v3 validator.** Migration packages are frozen historical snapshots of the format they migrate from, as [Released Session formats migrate through stateful streaming stages](../architecture/2026-08-31-released-session-format-migrations.md) owns, and whether that member legitimately appeared in a v2 log is a separate format-version question. It also covers only part of the observed refusals: most were `cannot safely transform unclassified message source`, which no member allowlist admits.

**Translate the refusal into `SESSION_QUERY_SEARCH_DISABLED` or a dedicated code.** This names the cause more honestly to the model and still returns nothing, hiding a readable corpus behind one unreadable log.

**Record per-Session refusals as index state.** A bounded refusal memo would avoid re-reading refused logs on later reconciles, but repeated searches over a store with 27 refused logs already measure 0.16s warm, so no current consumer needs the extra state and its invalidation rules.

## Consequences

Search degrades to the readable corpus instead of failing: operators with pre-V3 history keep search working, and `session history storage is unavailable` again means the backend itself is unreachable. A refused log stays out of results permanently, which is silent by design — nothing reports how much history a given index cannot read. An index row written before a log became unreadable is not deleted by the refusal, so such a Session can keep matching from its last successfully indexed generation.

`session-query-sqlite/tests/sqlite.spec.ts` mounts the engine over one readable and one format-refusing stored Session and asserts the search page returns the readable hit, that later searches still succeed, and that the refused Session matches nothing. A recorded-session snapshot for this path needs a fixture carrying an un-migratable log, which the snapshot harness cannot express today; that coverage gap is stated rather than papered over.
