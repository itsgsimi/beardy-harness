# Agent Note：Beardy skill 管理

Status: implemented

[English](2026-08-29-beardy-skill-management.md) | 中文

## 问题

Beardy 可以加载 workspace skill，但没有面向模型的操作来创建或删除其 loader 使用的扁平 skill 文档。提供临时的 filesystem 路径会重复 filesystem policy，也会让该能力更难随未来 Harness 更新维护。

## 决策

在 `@deepseek-ai/dsh-tool-skill` 中加入选择启用的 `skill_manage` 工具。该工具创建、替换和删除 `<workspace>/.agents/skills/<kebab-name>.md`，校验自己负责的 Markdown frontmatter 字段，并通过 `ctx.fs` 能力执行所有 filesystem 操作。因此 filesystem seam 负责 sandbox 检查、原子写入、过期版本保护、锁与普通文件删除；工具只负责 skill 文档格式和扁平目标限制。

skill-tool 配置中的 `enableSkillManagement` 会启用该工具，Creator 与 Beardy preset 层选择开启它。成功的变更会发出已有的 filesystem observation 事件，skill-filesystem provider 将 `skill_manage` 视为目录变更，使当前会话收到刷新后的 skill 列表。standard profile 保持关闭该选项。

## Alternatives considered

### 为什么不让模型直接使用 `write` 或 `shell`？

这些工具提供通用 filesystem 操作，并把 skill 命名、frontmatter、删除语义和目录刷新协调留给提示词。专用工具可以收窄模型可见操作，并复用现有 filesystem policy。

### 为什么不增加 skill 专用存储 provider？

loader 已经把 workspace Markdown 文件作为事实来源。第二个存储会增加同步与优先级规则，却不会改善 skill 格式；现有 filesystem seam 已提供所需的变更保证。

### 为什么不实现递归目录删除？

面向模型的操作一次管理一个已知普通文件。递归删除会把破坏性范围扩大到 skill 删除所需之外。

## 后果

Beardy 可以使用 `action: "create"` 调用 `skill_manage` 创建 skill，使用 `action: "update"` 更新完整 Markdown 文档，并使用 `action: "delete"` 删除它。创建和更新需要 description 与 content；名称必须使用 kebab-case；删除会拒绝目录与不存在的文件。管理器通过 filesystem 能力创建 workspace skill 目录，并拒绝逃逸 workspace 或符号链接目标。

该能力明确选择启用，因此现有组合不会自动获得新的变更工具。它只管理扁平 workspace skill，不会生成多文件 skill 目录、编辑已安装或全局 skill，也不会在没有模型调用的情况下自动整理 skill。
