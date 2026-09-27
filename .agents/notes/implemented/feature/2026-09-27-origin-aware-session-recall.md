# Agent Note: Origin-aware session recall

Status: implemented

English | [中文](2026-09-27-origin-aware-session-recall.zh.md)

## Problem

`session_search` required a literal query, so a caller asking what happened recently had to invent a search term. Event-frequency ranking could put routine cron runs ahead of an interactive conversation or a Session whose title matched the user's words. Sorting a capped tool result afterward could not recover a useful Session that the provider's earlier page limit had already excluded.

## Decision

`session_search` accepts `view: recent` without a query or event filters and returns the newest authorized Sessions by creation time, at most `maxRecentSessions` (default 20, a validated tool `Config` field). It reads `ctx.sessionQuery.filterSessions` with the same exact-`cwd` filter, caller exclusion, requested-parent authorization, and research-stage exclusion as text search, so it also works when full-text search is disabled. A capped page tells the model to page back with `created_at_to`.

Both views accept `origin: interactive | cron | discord | all`; omitted and `all` include every origin. `sessionRecallOrigin` in `dsh-session-query` classifies a header: the cron and Discord launchers issue `cron-` and `discord-` Session ids, a subagent child (positive `delegationDepth`) takes its direct parent's origin, and every other Session is `interactive`. `dsh-session-query-sqlite` compiles the same rule into SQL. Origin is a recall preference, not an authorization identity.

The SQLite provider ranks inside its query, before the page limit: non-cron Sessions first, then Sessions whose latest title matches, then the existing match-count and length order. Discord conversations are user conversations and rank with interactive ones. Only the latest logged `session/title` event is indexed as searchable text, and a Session's best match is its strongest non-title event unless only the title matched. Indexing title documents raised the derived index schema to version 9, so an existing index resets and rebuilds once. Every listing entry shows title, creation time, origin, parent, and availability.

## Alternatives considered

**Add a durable origin header field.** This would classify arbitrary custom Session ids exactly, but it changes the released Session header and needs a coordinated format migration for a recall preference. The launchers already use stable id namespaces.

**Resolve origin through the whole lineage.** A recursive walk would classify deeper delegation chains, but it needs a recursive SQL query and a corpus-wide lookup for presentation. Subagent delegation defaults to depth one, so the direct parent covers the delegated work a cron or Discord run creates.

**Sort the returned search page in the tool.** A provider cap could discard title or interactive hits before the tool sees them. Provider-side ranking makes the cap meaningful.

**Add a separate recent tool.** It would duplicate the same access and filter decisions and add another schema to every model request. A view on `session_search` keeps one retrieval entry point.

## Consequences

Custom launcher ids, forks, and deeper delegation chains classify as `interactive`; the classifier is deliberately not a provenance guarantee. The recent view lists the logical corpus before taking its bounded page, so its work scales with stored Session count even though model output is bounded. Search no longer matches a superseded title. Search and recent results remain reconstructable from logged headers and title events.

Focused tool, service, and SQLite tests cover origin classification and filters in both views, delegated children, authorization, page bounds, title and origin ranking before the limit, and superseded titles. The keyless `session-query-recent` recorded Session exercises a recent-view call and pins the changed schema and guidance through the shipped headless profile; its workspace has no prior Session, so listed-entry text is pinned by unit tests rather than the recording.
