---
description: "Discord 分组的导览：一个走 REST API 的面向模型发送工具，与一个把私信变成会话的网关监听器，供把 agent 接入 Discord 频道、或从 Discord 与 agent 协作的用户阅读。"
kind: "package-group"
---

# discord/ — Discord 投递与对话

[English](README.md) | 中文

## 概述

Discord 分组通过两个独立的包双向连接 agent。面向模型的 `discord_send` 工具通过 REST API 把消息发到配置的频道或允许清单用户的私信，并拆分过长正文、中和广播提及。网关读取允许清单中的私信，为每个频道开启一个 Host 会话，并通过同一投递路径发送回答。两半均可独立运行。两者都通过凭据引用解析 bot token，且一个 token 只允许一个进程完成 identify。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx key |
|---|---|---|
| [`tool-discord/`](tool-discord/README.zh.md) | 面向模型的 `discord_send` 工具，经 Discord REST API 投递，带分条与提及改写 | registers on `ctx.tools` |
| [`discord-gateway/`](discord-gateway/README.zh.md) | Gateway v10 监听器，把允许清单用户的私信变成本机会话，并在原地回复 | consumes `ctx.agents`、`ctx.agentPresets`、`ctx.permissionPresets`、`ctx.workspaceRegistry` |

-----

<a id="related-documentation"></a>
## 相关文档

- [本机级 cron 与 Discord 投递 Agent Note](../../.agents/notes/implemented/feature/2026-09-05-host-cron-with-discord-delivery.zh.md) —— 为什么投递与入站对话是两个独立的包，以及各自推迟了什么。
- [`dsh-cron`](../cron/cron/README.zh.md) —— 驱动无人值守运行的调度器，其输出由本组的包投递。
