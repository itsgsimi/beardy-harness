---
description: "cron 分组的导览：一个本机（Host）级调度器，按真实时钟把配置好的任务作为全新会话无人值守地运行，供希望 agent 无需被请求即可行动的操作者阅读。"
kind: "package-group"
---

# cron/ — 无人值守的定时 agent 运行

[English](README.md) | 中文

## 概述

cron 分组在无人到场时让 agent 按时间表运行。任务在配置中声明——一个 cron 表达式、一个 IANA 时区、一段提示词，以及塑造该次运行的 agent 预设与权限预设组合——每次触发都开启自己的会话，因此事后可以搜索到这次运行，其日志也能重建每一步。配置在加载时校验：重复的任务名、不可用的表达式或时区、相对的工作区路径都会让启动失败，而不是留下一个永不触发的任务。本组不做投递；一次运行通过其预设挂载的任意工具影响外部世界，例如 [`discord_send`](../discord/tool-discord/README.zh.md)。带持久规则的会话作用域提醒属于 [`dsh-schedule`](../schedule/schedule/README.zh.md)，不属于这里。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx key |
|---|---|---|
| [`cron/`](cron/README.zh.md) | 挂载配置中的 cron 任务，并为每次触发开启一个无人值守的会话 | consumes `ctx.agents`、`ctx.agentPresets`、`ctx.permissionPresets`、`ctx.workspaceRegistry`、`ctx.sessionTitle` |

-----

<a id="related-documentation"></a>
## 相关文档

- [本机级 cron 与 Discord 投递 Agent Note](../../.agents/notes/implemented/feature/2026-09-05-host-cron-with-discord-delivery.zh.md) —— 为什么本机级调度器与 `dsh-schedule` 分开，以及它推迟了什么。
