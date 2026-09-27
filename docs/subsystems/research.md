# Research runs

English | [中文](research.zh.md)

`ctx.research` exposes owner-scoped, Session-backed research runs. The [definition package](../../packages/research/research/README.md) owns the service and event types; the [local provider](../../packages/research/research-local/README.md) owns persistence and recovery. The [decision record](../../.agents/notes/implemented/feature/2026-09-27-session-backed-research-runs.md) explains why run Sessions are the durable authority.

## Durable identity and ownership

`ResearchRunId` serializes to the same `rp-native-` identity as the run Session ID. `ResearchOwner` is either an exact caller Session or an explicitly configured single-user profile namespace. The provider checks the owner saved in `research/started` before reading or changing a run; a model argument cannot choose it. The profile option needs a separate authenticated principal adapter before multiuser use.

## Session events and recovery

`research/started`, `research/checkpoint`, and `research/finished` belong to the run Session; `research/linked` belongs to the caller Session. The start record is flushed before caller linkage, so a failed caller flush leaves a discoverable run. Checkpoints record stage Session IDs, source attachment references, and round progress. The first terminal event wins. A first access after process restart writes `interrupted` for each unfinished persisted run without replaying external effects. Completion requires both report and evidence file attachments; they are committed before the terminal event that references them and verified on read. The [persistence catalog](../persistence-catalog.md) contains the exact event payload declarations.

## Stage Session recall

The engine will create each model stage as a child Session of the run. The existing `parentSession` header can identify a research child by its `rp-native-` parent ID without changing the V4 header. Generic Session lists and `session_search` do not exclude those children today, so the Session presentation spine needs a default filter for that parent ID class while retaining explicit ID inspection. The storage provider does not create stage Sessions yet.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxresearch--researchservice-abstract-seam"></a>

### `ctx.research` — `ResearchService` (abstract seam)

Durable research lifecycle and report access.

```ts cordis-catalog
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
