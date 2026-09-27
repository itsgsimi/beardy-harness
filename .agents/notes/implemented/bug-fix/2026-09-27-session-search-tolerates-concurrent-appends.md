# Agent Note: Session search tolerates concurrent appends

Status: implemented

English | [中文](2026-09-27-session-search-tolerates-concurrent-appends.zh.md)

## Problem

Each SQLite session search lists persistence, reads new or changed logs, and lists persistence again. The observation accepted the result only when both listings carried identical revisions, and it allowed one retry. Any Session writing during that window therefore failed the attempt, and two failed attempts surfaced `SESSION_QUERY_PERSISTENCE_FAILED`, which `session_search` reports as `session history storage is unavailable`.

The JSONL backend makes the window common. The revision of every historical-format Session includes a hash over the stat identity of every stored log, so any append anywhere changes all of those revisions. A deployment with pre-V4 history re-reads that history on every search after any write, and a concurrent Discord, cron, subagent, or Web Session appending during the re-read fails the comparison again. A real-backend test with one V3 Session and one appending writer reproduces the error.

## Decision

`_observeStable` in `session-query-sqlite` requires the two listings to name the same Sessions with the same immutable headers and ignores revision changes between them. Each log read in the observation is stored under the revision from the first listing. That label is never newer than the content read after it, so a log appended during the window has an unequal revision at the next search and is read again there. Population or header changes, live-owner changes, and persistence-binding changes still retry once and then fail.

A Session listed but missing when opened, such as a created Session closed before its first append, is observed as deleted. The second listing retries only if it lists that Session again.

The persistence dependency stays an optional peer: the engine imports `SessionPersistenceNotFoundError` dynamically, as it already imports `SessionFormatUnsupportedError`.

## Alternatives considered

**Retry more times.** A busy deployment appends continuously, and each attempt re-reads the same historical logs, so more attempts lengthen the search without bounding failure.

**Ignore revision changes only for live Sessions.** The caller's own Session is live, but historical-format revisions change whenever any log changes, so this still fails whenever pre-V4 history exists.

**Narrow the JSONL historical revision.** Hashing only the logs a historical migration reads would also end the repeated re-reads. That revision contract belongs to `session-persistence-jsonl` and protects migrations that read related child logs; it needs its own change.

## Consequences

A search may answer from logs read up to one observation window after the first listing. Its next search reads every log that changed, so no stale content persists. `session history storage is unavailable` now means a listing or read failed, or the stored population or live owners kept changing across the retry. Deployments with historical-format Sessions still re-read that history on each search after any write; the search completes but pays for those reads.

`session-query-sqlite/tests/sqlite.spec.ts` covers revision churn, a Session missing at open, a Session listed again after a missing read, population churn, and the real JSONL backend with a V3 Session and a concurrent writer. The last test fails with the previous revision comparison.
