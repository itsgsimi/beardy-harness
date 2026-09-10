---
description: "cron 分组的导览：一个本机（Host）级调度器，按真实时钟把配置好的任务作为全新会话无人值守地运行，供希望 agent 无需被请求即可行动的操作者阅读。"
kind: "package-group"
---

# cron/ — 无人值守的定时 agent 运行

[English](README.md) | 中文

## 概述

cron 分组在无人到场时让 agent 按时间表运行。任务来自配置，或通过 `cron_manage` 与 `/cron` 持久管理。每次接受触发后，调度器使用任务的计划、时区、提示词、预设、工作区和当前连续性笔记开启全新 Session。持久预留记录和运行结果可以在重启后识别未完成的工作；完成的文本会等待[Discord 网关](../discord/discord-gateway/README.zh.md)等投递监听器接受。[cron 包](cron/README.zh.md)负责配置、恢复与投递的详细说明。会话作用域的提醒属于 [`dsh-schedule`](../schedule/schedule/README.zh.md)。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx key |
|---|---|---|
| [`cron/`](cron/README.zh.md) | 管理配置任务与存储任务，运行无人值守 Session，并保存结果直到投递方接受 | consumes `ctx.agents`、`ctx.agentPresets`、`ctx.permissionPresets`、`ctx.workspaceRegistry`、`ctx.sessionTitle` |

-----

<a id="related-documentation"></a>
## 相关文档

- [Cron 子系统参考](../../docs/subsystems/cron.zh.md) — 运行结果与交付确认事件。
- [本机级 cron 与 Discord 投递 Agent Note](../../.agents/notes/implemented/feature/2026-09-05-host-cron-with-discord-delivery.zh.md) —— 为什么本机级调度器与 `dsh-schedule` 分开，以及它推迟了什么。
