# Agent Note: 按来源识别的会话召回

Status: implemented

[English](2026-09-27-origin-aware-session-recall.md) | 中文

## Problem

`session_search` 要求字面查询，因此调用方询问近期发生了什么时，必须自己编造一个搜索词。按事件频率排序可能让日常 cron 运行排在交互对话或标题匹配用户措辞的 Session 之前。工具拿到受限结果后再排序，无法找回提供方较早分页上限已经排除的有用 Session。

## Decision

`session_search` 接受不带查询和事件过滤器的 `view: recent`，按创建时间返回最新的已授权 Session，最多 `maxRecentSessions` 个（默认 20，是经过校验的工具 `Config` 字段）。它读取 `ctx.sessionQuery.filterSessions`，并使用与文本搜索相同的严格 `cwd` 过滤、调用方排除、请求父会话授权和研究阶段排除，因此全文搜索被禁用时它仍可用。结果达到上限时提示模型用 `created_at_to` 向前翻页。

两种视图都接受 `origin: interactive | cron | discord | all`；省略或使用 `all` 会包含所有来源。`dsh-session-query` 中的 `sessionRecallOrigin` 对 header 分类：cron 与 Discord 启动器签发 `cron-` 与 `discord-` Session id，subagent 子会话（`delegationDepth` 为正）沿用其直接父会话的来源，其它 Session 都归为 `interactive`。`dsh-session-query-sqlite` 把同一规则编译为 SQL。来源是召回偏好，不是授权身份。

SQLite 提供方在查询内、分页上限之前排序：非 cron Session 在前，其次是最新标题匹配的 Session，然后沿用既有的匹配次数与长度顺序。Discord 对话是用户对话，与交互对话同级排序。只有最新的已记录 `session/title` 事件会被索引为可搜索文本；会话的最佳匹配是其最强的非标题事件，只有标题匹配时才是标题。索引标题文档使派生索引 schema 升至版本 9，因此现有索引会重置并重建一次。每个列表条目都显示标题、创建时间、来源、父会话与可用性。

## Alternatives considered

**增加持久化的来源 header 字段。** 这能精确分类任意自定义 Session id，但会改变已发布的 Session header，并为召回偏好要求协调格式迁移。启动器已经使用稳定的 id 命名空间。

**沿整条血缘解析来源。** 递归遍历能分类更深的委派链，但需要递归 SQL 查询，并需要为展示做全语料查找。subagent 委派默认深度为一，因此直接父会话已覆盖 cron 或 Discord 运行创建的委派工作。

**在工具中排序返回的搜索页。** 提供方上限可能在工具看到标题或交互命中之前就将其排除。在提供方侧排序使结果上限有意义。

**新增独立的近期工具。** 这会重复相同的授权与过滤决策，并给每次模型请求增加一个 schema。`session_search` 的视图让检索保持单一入口。

## Consequences

自定义启动器 id、fork 与更深的委派链会归为 `interactive`；分类器有意不保证来源凭证。近期视图先列出逻辑语料再截取有界页面，因此即使模型输出有界，其工作量仍随存储的 Session 数量增长。搜索不再匹配已被取代的标题。搜索与近期结果仍可由已记录的 header 和标题事件重建。

聚焦的工具、服务与 SQLite 测试覆盖两种视图中的来源分类与过滤、委派子会话、授权、分页上限、分页上限之前的标题与来源排序，以及已被取代的标题。无密钥的 `session-query-recent` 已记录 Session 执行一次近期视图调用，并通过正式 headless profile 固定变更后的 schema 与指引；其工作区没有既往 Session，因此列表条目文本由单元测试而非录制固定。
