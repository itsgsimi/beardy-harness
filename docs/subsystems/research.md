# Research runs

English | [中文](research.zh.md)

`ctx.research` exposes owner-scoped, Session-backed research runs. The [definition package](../../packages/research/research/README.md) owns the service and event types; the [local provider](../../packages/research/research-local/README.md) owns the web and model engine, persistence, and recovery. The [tool consumer](../../packages/research/tool-research/README.md) exposes `deep_research` to a caller model. The [decision record](../../.agents/notes/implemented/feature/2026-09-27-session-backed-research-runs.md) explains why run Sessions are the durable authority.

## Durable identity and ownership

`ResearchRunId` serializes to the same `rp-native-` identity as the run Session ID. `ResearchOwner` is either an exact caller Session or an explicitly configured single-user profile namespace. The provider checks the owner saved in `research/started` before reading or changing a run; a model argument cannot choose it. The profile option needs a separate authenticated principal adapter before multiuser use.

## Session events and recovery

`research/started`, `research/search`, `research/source`, `research/finding`, `research/checkpoint`, and `research/finished` belong to the run Session; `research/linked` belongs to the caller Session. The start record is flushed before caller linkage and engine launch, so a failed caller flush leaves a discoverable unlaunched run. Search and fetch outcomes, normalized extraction, stage Session IDs, draft references, and round progress pass the run's flush barrier before publication. Exact bounded fetched text is attached before its source event. The first terminal event wins. A first access after process restart writes `interrupted` for each unfinished persisted run without replaying external effects. Report and evidence files are attached before a terminal reference and verified on read; an available draft becomes a partial report on cancellation or interruption. The [persistence catalog](../persistence-catalog.md) contains the exact event payload declarations.

## Stage Session recall

The engine creates one short-lived Agent/Session for each model call, with the run ID in its `parentSession` header. Each child records the exact prompt, request header, assistant response or attempt, and turn end; `deriveMessages()` reconstructs every model request. A default API Session list or `session_search` omits children whose parent ID starts with `rp-native-`. An explicit Session ID read and an explicitly requested parent search still reach them. Stage Agents expose no model tools and deny tool execution. Each stage sends bounded context, so earlier page text enters later calls only through logged prompts.

The run and its stage children retain the caller Session's workspace path when one exists, so explicit workspace-authorized reads can reach the stage logs. Session mention candidates apply the same default stage exclusion.

## Evidence and stopping

The general engine uses versioned Odysseus-derived plan, query, extraction, synthesis, stop, and final-report prompts. `ctx.web` supplies search and fetch with the run's abort signal; the web tool's shared HTML converter supplies bounded Markdown. The engine deduplicates queries and URLs, records unsuccessful searches and fetches, and stops after the configured empty-round limit, a model coverage decision after minimum rounds, a soft deadline, or the hard round cap. The hard deadline includes model admission wait and final attachment writes. Report links are checked against accepted fetched URLs; a URL match establishes that the URL was fetched, not that it supports the claim. The native fantasy-football category is refused until its specialized workflow is available.

## Model access and Beardy selection

`deep_research` provides `start`, `status`, `report`, `list`, and `cancel`. The consumer derives an owner from the caller Session and uses the tool-call ID as an exact start key. Status, list, and report reads return paged JSON with `next_offset` and `total_chars`; report page zero carries full `researchArtifact` viewer metadata. Models must concatenate all pages before parsing the report, cite source URLs, and treat source text as untrusted. The run and report remain readable by ID after restart. The Web research row renders both native and Odysseus tool calls with locale-owned copy.

Beardy retains its Odysseus bridge selection until the operator applies the [native research switch](../../packages/bundle/beardy/README.md#select-native-deep-research). The patch enables the local provider and tool together while disabling the bridge. Both tool plugins reject a composition that mounts the other.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxresearch--researchservice-abstract-seam"></a>

### `ctx.research` — `ResearchService` (abstract seam)

Durable research lifecycle and report access.

```ts cordis-catalog
/**
 * Derive the configured run authority from a live caller Session.
 * @param caller - Session executing a trusted consumer action.
 * @returns caller-scoped or configured single-user profile authority.
 */
abstract ownerFor(caller: Session): ResearchOwner

/**
 * Commit a run Session, then link and flush the caller Session before returning.
 * @param request - live caller, trusted owner, question, and optional exact-call idempotency key.
 * @returns the durable run view; duplicate keys return the same run.
 */
abstract start(request: ResearchStart): Promise<ResearchRunView>

/**
 * Read a run without revealing foreign or missing identities.
 * @param id - run identity.
 * @param owner - trusted reading authority.
 * @returns current durable view.
 */
abstract status(id: ResearchRunId, owner: ResearchOwner): Promise<ResearchRunView>

/**
 * Project stored run Sessions and return an owner-filtered page.
 * @param request - trusted owner and page selection.
 * @returns durable views, newest first.
 */
abstract list(request: ResearchList): Promise<readonly ResearchRunView[]>

/**
 * Verify immutable report files before exposing their contents.
 * @param id - run identity.
 * @param owner - trusted reading authority.
 * @returns completed or explicitly partial report.
 */
abstract report(id: ResearchRunId, owner: ResearchOwner): Promise<ResearchReport>

/**
 * Commit a cancellation request; the first terminal result remains authoritative.
 * @param id - run identity.
 * @param owner - trusted cancelling authority.
 * @returns whether this call requested cancellation.
 */
abstract cancel(id: ResearchRunId, owner: ResearchOwner): Promise<{ requested: boolean }>
```

Types: [Session](session.md)

Source: [`packages/research/research/src/index.ts`](../../packages/research/research/src/index.ts)

<a id="research-events"></a>

### `research/*` events

<a id="researchchanged--emit"></a>

#### `research/changed` — emit

A run view changed after its run Session passed the durability barrier.

```ts cordis-catalog
/**
 * A run view changed after its run Session passed the durability barrier.
 * @mode emit
 * @param payload - committed run view for a local observer.
 */
'research/changed'(payload: { run: ResearchRunView }): void
```

Source: [`packages/research/research/src/index.ts`](../../packages/research/research/src/index.ts)
<!-- END GENERATED cordis-surface -->
