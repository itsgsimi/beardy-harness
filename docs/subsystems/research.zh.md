# 研究运行

[English](research.md) | 中文

`ctx.research` 提供按所有者隔离、以 Session 保存的研究运行。[定义包](../../packages/research/research/README.zh.md)拥有服务和事件类型；[本地提供方](../../packages/research/research-local/README.zh.md)负责网页与模型引擎、持久化及恢复。[决策记录](../../.agents/notes/implemented/feature/2026-09-27-session-backed-research-runs.zh.md)解释为何运行 Session 是持久权威。

## 持久身份与所有权

`ResearchRunId` 序列化后与运行 Session ID 使用同一个 `rp-native-` 身份。`ResearchOwner` 可以是精确的调用方 Session，也可以是明确配置的单用户 profile 命名空间。提供方在读取或修改运行前检查 `research/started` 中保存的所有者；模型参数不能选择它。多用户部署使用 profile 选项前，还需要独立的认证主体适配器。

## Session 事件与恢复

`research/started`、`research/search`、`research/source`、`research/finding`、`research/checkpoint` 和 `research/finished` 属于运行 Session；`research/linked` 属于调用方 Session。启动记录先于调用方关联和引擎启动刷新，因此调用方刷新失败会留下可找到但尚未执行的运行。搜索与抓取结果、规范化提取、阶段 Session ID、草稿引用和轮次进度都在发布前通过运行的刷新屏障。精确的有界抓取文本先附加，再写入来源事件。第一个终态事件胜出。进程重启后首次访问会为每个尚未结束的持久运行写入 `interrupted`，不会重放外部工作。报告与证据文件先于引用它们的终态事件附加，读取时会验证；取消或中断时已有草稿成为部分报告。[持久化目录](../persistence-catalog.zh.md)包含精确的事件载荷声明。

## 阶段 Session 的回忆排除

引擎为每次模型调用创建短生命周期的 Agent/Session，并在其 `parentSession` 标头中写入运行 ID。每个子 Session 记录精确提示词、请求标头、助手回复或尝试以及轮次结束；`deriveMessages()` 可重建每次模型请求。默认 API Session 列表和 `session_search` 会省略父 ID 以 `rp-native-` 开头的子 Session。按明确 Session ID 读取或明确指定父 Session 的搜索仍可访问它们。阶段 Agent 不向模型暴露工具，并拒绝执行工具。每个阶段发送有界上下文，因此先前网页文本只有进入已记录提示词时才会进入后续调用。

运行及其阶段子 Session 会保留调用方 Session 的工作区路径（如果存在），因此明确授权的工作区读取仍可访问阶段日志。会话引用候选列表也默认排除阶段子 Session。

## 证据与停止条件

通用引擎使用源自 Odysseus、带版本号的规划、查询、提取、综合、停止和最终报告提示词。`ctx.web` 使用运行的中止信号提供搜索与抓取；网页工具的共享 HTML 转换器提供有界 Markdown。引擎对查询与 URL 去重，记录失败的搜索与抓取，并在达到配置的空轮次上限、最小轮数后的模型覆盖决策、软时限或硬轮数上限时停止。硬时限涵盖模型准入等待与最终附件写入。报告链接会与已接受的抓取 URL 核对；URL 匹配只证明来源，不能证明事实陈述。原生提供方在专用工作流可用前拒绝梦幻橄榄球类别。

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
