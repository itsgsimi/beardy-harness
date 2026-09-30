# Agent Note: 会话搜索工作区别名

Status: implemented

[English](2026-09-29-session-search-workspace-aliases.md) | 中文

## 问题

`@deepseek-ai/dsh-tool-session-query` 只在目标 Session 的 `cwd` 与调用方的 `cwd` 完全相等时才允许跨会话访问。Beardy 部署正把主工作区从 `/home/goran/deepseek-harness` 迁到 `/home/goran/.dsh/people/goran`。迁移后，`session_search` 及后续的追踪和读取工具，包括每日摘要与每周技能回顾的 cron 提示，都会丢失旧工作区中记录的所有 Session。

## 决策

插件新增经过校验的 `workspaceAliases` 字段，默认 `{}`。它把调用方工作区映射到该工作区还可搜索和读取其 Session 的其它绝对工作区。`resolveConfig` 用 `path.resolve` 规范化每个键和条目（会去掉末尾分隔符），遇到相对路径、规范化后重复的工作区或条目、或工作区以自身为别名时在加载时抛出。调用方的已授权工作区是它的 `cwd` 加上为它配置的条目；没有 `cwd` 的调用方仍只能看到自己。

同一工作区列表同时用于 `session_search` 两种视图的 `cwd` 过滤器、父 id 与目标预授权查询，以及对每个观察到的结果执行的 header 检查，因此经别名找到的命中可以被追踪和读取。授权单向且不可传递：旧工作区不获得任何访问，别名的别名也不会被跟随。会话列表只对 `cwd` 与调用方不同的 Session 增加一行 `Workspace:`，因此没有别名时输出不变，工具 schema 与快照都不变。

## 考虑过的替代方案

**改写旧 Session header 的 `cwd`。** 已提交的 Session 日志从不改写，旧工作区仍是带有自身 Session 的真实检出目录。

**对称或可传递的别名。** 迁移只让新工作区访问它产生过的历史；反向授权或链式授权会让权限超出部署配置的范围。

**让模型传入工作区参数。** 工作区授权来自调用方，绝不由模型提供。

## 后果

迁移工作区的部署在 `tool-session-query` 行中把旧路径列在新路径之下。测试覆盖默认的单工作区范围，经别名进行的搜索、近期列表、追踪、事件搜索与读取，被拒绝的反向访问，不可传递的链，以及每种加载时校验错误。
