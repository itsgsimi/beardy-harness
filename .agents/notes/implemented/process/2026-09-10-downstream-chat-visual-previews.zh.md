# Agent Note：下游重新落地聊天视觉预览

Status: implemented

[English](2026-09-10-downstream-chat-visual-previews.md) | 中文

## 问题

两项视觉交付能力对 fork 用户不可用。上游在 `origin/master` 上回滚了[静态 Markdown 围栏预览](../feature/2026-09-09-markdown-static-previews.zh.md)且未记录原因，Mermaid、Graphviz、SVG 与 HTML 围栏因此重新以代码呈现。[对话内视觉结论](../feature/2026-09-10-inline-visual-feedback.zh.md)只存在于一个私有工作分支上，没有任何 fork profile 交付 `present_visual`。

## 决策

`fork/downstream/main` 承载这两项能力。围栏预览的回滚在 fork 上被再次回滚，`present_visual` 的工作 cherry-pick 到同一条集成分支。两项能力保留各自随功能交付的记录；本记录只负责 fork 分叉这一决策。

`CodeBlock` 合并两条工作线而非二选一：下游引入的 `contentRef` 滚动容器现在包裹源码分支，且只在预览隐藏时挂载。文档预览侧栏不传 `preview` 属性，其滚动容器保持挂载且行为不变。

启动式工具目录期望值记录 fork 的完整交付集合——`discord_send`、`memory`、`odysseus_research`、`skill_manage` 与 `present_visual` 并列——因为该门禁在 `downstream/main` 上已经漂移为失败。

## 备选方案

**等待上游重新落地围栏预览。** 上游既未说明原因也未提供替代方案，等待时长不可预期，而 fork 用户始终看不到图表。

**只交付 `present_visual`。** 两项能力回应同一个用户预期——对话内看到视觉结果——且都改动 `ui-primitives`，分开落地会让合并工作量翻倍而不降低风险。

**把工具目录漂移并入功能提交。** 那四个下游工具名早于本次工作；单独的测试提交让功能提交的表述保持准确。

## 影响

每次 `origin/master` 合并前推都必须重新解决围栏预览的回滚：除非 fork 的重新落地胜出，上游合并会再次引入该删除。[上游同步流程](../../../skills/dsh-upstream-sync/SKILL.md)负责该解决方式。

证据：`typecheck`、`lint`、`build`、`doc-sync`、`test:snapshot` 以及 [Mermaid 预览](../../../../apps/web/tests/markdown-mermaid.e2e.ts)与[视觉反馈](../../../../apps/web/tests/visual-feedback.e2e.ts)的无密钥浏览器场景全部通过。完整单元套件仍有十一个文件失败，它们在 `downstream/main` 上同样失败；其中 `transform-corpus` 把 ui-dockkit 的容许失败钉在其自身 `lib` 样式表上，而构建产物如今先到达 `ui-primitives` 源码 CSS。该门禁本次未改动，需要单独修复。
