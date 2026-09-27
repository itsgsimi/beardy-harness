---
description: "health 包组：显式配置的端点探测与供运维人员查看的 Host 状态。"
kind: "package-group"
---

# health/ — 端点状态

[English](README.md) | 中文

## 概述

health 包组检查已配置的 HTTP 端点，并控制固定本地模型后端的主动卸载。Discord 网关通过现有 outbox 投递探针状态转换，并在 `/status` 中展示探测状态。[health 插件](health/README.zh.md)负责轮询与阈值行为；[本地模型控制](local-model-control/README.zh.md)负责人工命令与持久卸载意图。[子系统参考](../../docs/subsystems/health.zh.md)定义状态与事件类型。

## 包

| 包 | 职责 |
|---|---|
| [`health`](health/README.zh.md) | 探测轮询、阈值状态转换与有界状态事实 |
| [`local-model-control`](local-model-control/README.zh.md) | 人工加载或卸载命令，以及本地 provider 的持久主动暂停状态 |

## 开发备注

无。
