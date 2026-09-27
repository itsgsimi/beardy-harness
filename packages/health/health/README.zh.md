---
description: "显式 HTTP 端点探测、阈值告警与只读 Host 状态。"
kind: "package-reference"
---

# @deepseek-ai/dsh-health

[English](README.md) | 中文

## 概述

在 `probes` 中配置具名 HTTP 端点，以观察其可达性。空列表不对模型可用性作出断言。插件在内存中保存状态；配置 `noticeChannelId` 时，通过 Discord 网关的持久 outbox 发布宕机和恢复通知；同时向 `/status` 提供当前探测状态和最近观察到的 cron 失败。插件不会调用模型、重启 provider 或保存事故数据库。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Host 组合中挂载插件。已测试的空配置不会发出网络请求：

```yaml
- name: '@deepseek-ai/dsh-health'
  config:
    probes: []
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `probes` | `[]` | 唯一的 `{name, url, credentialRef?, expectedStatus?}` 目标；固定使用 `GET`，默认状态码为 200 |
| `intervalMs` | `60000` | 一轮探测完成后的等待时间 |
| `timeoutMs` | `3000` | 每次 HTTP 请求的时限 |
| `failureThreshold` | `3` | 判定宕机前连续失败的次数 |
| `recoveryThreshold` | `1` | 判定健康前连续成功的次数 |
| `noticeChannelId` | 缺省 | 状态转换通知的 Discord 频道；缺省时只保留状态 |
| `noticeCooldownMs` | `900000` | 状态反复波动时抑制同类重复通知 |

探针 URL 必须显式配置为 HTTP(S) 地址，不能含有嵌入的用户信息或片段。`credentialRef` 经凭据 provider 解析并作为 bearer token 发送；凭据缺失或 HTTP 状态不符计为失败。字段 schema 见生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-health)。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>展开查看实现内部机制</summary>

监测器在一轮串行探测中检查已配置目标。失败与恢复计数在达到配置阈值时改变各探针的进程内状态。首次成功只进入健康状态，不发送通知。状态转换以稳定标识进入 gateway 的持久 outbox；接收失败时沿用同一标识重试，后续探测仍会继续。网关恢复接收后，按顺序提交待处理的转换。冷却期分别作用于宕机与恢复通知。URL 对应的[本地后端](../local-model-control/README.zh.md)若被主动卸载，探针会显示操作者与时间，跳过请求和宕机通知。health owner 为 `/status` 观测 cron 失败结果，不另发第二条通知。

| 源码 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 校验、探测、状态快照与状态转换交接 |
| [gateway](../../discord/discord-gateway/README.zh.md) | 持久 outbox 接收与面向人的 `/status` 回复 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [端点健康状态参考](../../../docs/subsystems/health.zh.md) — 状态与 Host API。
- [Cron 包](../../cron/cron/README.zh.md) — 持久逐任务结果历史与 `/cron status`。
- [Beardy 组合包](../../bundle/beardy/README.zh.md) — 空探针挂载与部署配置。

-----

<a id="model-experience"></a>
## 模型体验

无，因为该 Host 插件只探测配置的端点并提供人类命令状态，不添加模型输入或工具。

#### KV Cache 影响

无；探测和 outbox 通知不改变模型请求。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **HTTP 可达不等于生成健康。** 端点返回成功状态不能证明 provider 可以回答模型请求。
- **重启后探测状态重置。** 下一轮探测从 `unknown` 开始；插件不保存事故历史。Discord outbox 会在投递重试期间保留已接收的通知。
- **Cron 事实只在进程内保留。** `/status` 显示本次 Host 挂载期间观察到的最近失败；`/cron status` 读取调度器的持久逐任务历史。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>展开查看维护者工作说明</summary>

本包不发布运行时 invariant 伴随包：每个探针只有一个内存状态所有者，outbox 接收由 Discord gateway 负责。

</details>
