# 研究运行

[English](research.md) | 中文

`ctx.research` 提供按所有者隔离、以 Session 保存的研究运行。[定义包](../../packages/research/research/README.zh.md)拥有服务和事件类型；[本地提供方](../../packages/research/research-local/README.zh.md)负责持久化和恢复。[决策记录](../../.agents/notes/implemented/feature/2026-09-27-session-backed-research-runs.zh.md)解释为何运行 Session 是持久权威。

## 持久身份与所有权

`ResearchRunId` 序列化后与运行 Session ID 使用同一个 `rp-native-` 身份。`ResearchOwner` 可以是精确的调用方 Session，也可以是明确配置的单用户 profile 命名空间。提供方在读取或修改运行前检查 `research/started` 中保存的所有者；模型参数不能选择它。多用户部署使用 profile 选项前，还需要独立的认证主体适配器。

## Session 事件与恢复

`research/started`、`research/checkpoint` 和 `research/finished` 属于运行 Session；`research/linked` 属于调用方 Session。启动记录先于调用方关联刷新，因此调用方刷新失败会留下可找到的运行。检查点记录阶段 Session ID、来源附件引用和轮次进度。第一个终态事件胜出。进程重启后首次访问会为每个尚未结束的持久运行写入 `interrupted`，不会重放外部工作。完成状态要求同时保存报告和证据文件附件；它们先于引用它们的终态事件提交，读取时会验证两个文件。[持久化目录](../persistence-catalog.zh.md)包含精确的事件载荷声明。

## 阶段 Session 的回忆排除

引擎将把每个模型阶段创建为运行的子 Session。现有 `parentSession` 标头可以通过 `rp-native-` 父运行 ID 识别研究子 Session，无需修改 V4 标头。目前普通 Session 列表和 `session_search` 不会排除这些子 Session，因此引擎创建它们之前，Session 展示层需要为此类父 ID 加入默认过滤，同时保留通过 ID 显式查看的能力。存储提供方目前不创建阶段 Session。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
