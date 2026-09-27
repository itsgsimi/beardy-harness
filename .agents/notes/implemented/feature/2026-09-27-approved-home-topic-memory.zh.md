# Agent Note: 已批准的主目录写入与主题记忆

Status: implemented

English | [中文](2026-09-27-approved-home-topic-memory.md)

## Problem

Beardy 的精选记忆和用户技能位于 Harness 主目录中，不在会话工作区内。在 `workspace-write` 模式下，即使人工批准，这些工具也无法保存到该目录。定时运行可以请求批准，却没有绑定其投递频道的应答方。两个核心记忆文件也容纳不下较详细的长期家庭信息。

## Decision

`tool-memory` 和 `tool-skill` 只有在 `approval.request()` 返回 `allowed-once` 后，才能为一个准确的 Harness 主目录文件，或必要的 `memories`、`skills` 目录创建，请求一次性文件系统许可。`fs-sandbox` 仅在 `workspace-write` 模式下接受许可；它重新解析目标，检查目标仍在配置的主目录内，并拒绝目标及其到主目录之间的符号链接。许可不会进入 `writableRoots()`、shell 或子进程策略。`read-only` 仍拒绝写入。可选配置 `allowApprovedHomeWrites` 要求同时启用 `requireApproval`；Beardy 预设启用两者。

活动中的定时运行将其 Agent 与配置的投递频道关联。Discord 网关仅在该频道被允许时认领这个 Agent 当前的批准请求；按钮或表情回应必须指向请求 ID 或提示消息。普通文本不能批准定时运行。缺少频道、监听器或控件，以及超时和重启，都会使请求得不到批准。

现有的 `memory` 工具还按需提供 `memories/` 下的主题文件。主题写入保留所有者使用的 frontmatter 和 Rule、Why、History Markdown 结构；删除操作将文件标记为已停用。读取返回内容版本，替换和停用必须提供该版本。主题不会加入基础提示。可配置的文件大小、文件数量和读取上限约束这一层；核心记忆的容量和匹配歧义错误会列出当前条目。

## Alternatives considered

**将 Harness 主目录加入可写根目录。** 这也会让通用文件系统、shell 和子进程使用者在 `workspace-write` 模式下获得宽泛的写入权限。

**将批准视为永久权限变化。** 持续有效的许可可能超过已批准操作的生命周期，也无法标识所有者审核过的文件。

**通过普通 Discord 文本回答定时运行的批准请求。** 简单回复无法标识待处理运行的请求，也可能与普通会话回复混淆。

**将所有主题注入每次提示。** 这会让无关细节占用基础上下文，并重现核心文件的容量问题。

## Consequences

主目录例外仅限刚获得批准的可信工具调用；定时写入还需要实时可用的 Discord 配置路由。主题读取需要一次工具调用，核心指针可以提示 Agent 何时读取主题。主题编辑与核心指针编辑是两次独立的版本化写入；如果只完成其中一步，所有者必须协调处理。
