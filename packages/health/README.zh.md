---
description: "health 包组：显式配置的端点探测与供运维人员查看的 Host 状态。"
kind: "package-group"
---

# health/ — 端点状态

[English](README.md) | 中文

## 概述

health 包组只检查显式配置的 HTTP 端点，并在 Host 进程内保存当前状态。Discord 网关通过现有 outbox 投递状态转换通知，并在 `/status` 中展示探测状态。[health 插件](health/README.zh.md)负责配置和阈值行为；[子系统参考](../../docs/subsystems/health.zh.md)定义状态与事件类型。

## 包

| 包 | 职责 |
|---|---|
| [`health`](health/README.zh.md) | 探测轮询、阈值状态转换与有界状态事实 |

## 开发备注

无。
