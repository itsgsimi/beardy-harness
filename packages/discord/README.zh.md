---
description: "Discord 分组的导览：一个走 REST API 的面向模型发送工具，与一个把私信变成会话的网关监听器，供把 agent 接入 Discord 频道、或从 Discord 与 agent 协作的用户阅读。"
kind: "package-group"
---

# discord/ — Discord 投递与对话

[English](README.md) | 中文

## 概述

Discord 分组用两个互相独立的包把 agent 与 Discord 双向连通。投递是一个面向模型的 `discord_send` 工具，把消息发到配置的频道，或发到允许清单中用户的私信；它会切分过长正文并改写广播提及，直接调用 REST API 且不持有 Discord 状态。对话方向相反：一个网关 websocket 读取允许清单用户的私信，在本机（Host）按频道开启会话，并把每个回答发回消息来源处。两半都可以单独挂载——投递只需要凭据提供方，而入站对话复用同一条投递路径发送回复。两者都通过凭据引用解析 bot token，因此组合文件里不会出现 token；且恰好只能有一个进程用给定的 bot token 完成 identify。

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
