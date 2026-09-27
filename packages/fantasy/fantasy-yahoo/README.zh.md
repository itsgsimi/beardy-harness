---
description: "带 DSH 自有 OAuth 存储和人工授权命令的 Yahoo Fantasy v2 只读提供方。"
kind: "package-reference"
---

# @deepseek-ai/dsh-fantasy-yahoo

[English](README.md) | 中文

## 概述

读取 Yahoo Fantasy 数据而不向模型暴露凭据。提供方将现有私有缓存一次性导入自己的存储，在跨进程锁下刷新该存储，并向人工调用方提供 `/fantasy auth` 和 `/fantasy status`。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

装载提供方时，在 `$DSH_HOME` 下指定私有 JSON `tokenFile`。若存储不存在，将 `importFrom` 指向私有 yahoo_oauth JSON 文件。提供方在加载时验证来源，在首次使用时复制，并且从不写入来源。`redirectUri`、`season`、`callerTeams` 和 `authPresets` 是必填项。Beardy 个人配置提供这些账户专用值。

| Config | Meaning |
|---|---|
| `tokenFile`, `importFrom` | DSH 自有的 0600 存储和可选的一次性只读来源 |
| `redirectUri`, `season` | OAuth 回调与 NFL 赛季 |
| `callerTeams`, `authPresets` | 预设到球队的映射及授权许可预设 |
| `cacheTtlMs`, `cacheMaxEntries` | 有界响应缓存 |
| `retryCount`, `retryDelayMs`, `requestTimeoutMs` | API 重试退避与截止时间 |
| `lockWaitMs`, `lockStaleMs` | 存储锁的等待与过期界限 |

`/fantasy auth` 返回 Yahoo 只读授权 URL。随后使用 `/fantasy auth <回调 URL 或代码>` 交换代码并替换 DSH 存储。命令不会将回调输入记入 Session 日志。`/fantasy status` 报告 token 年龄、最近刷新时间、API 可达性、联盟数量和配置的球队键，不包含凭据。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

Yahoo JSON 使用 `fantasy_content`、数字键集合和由局部实体对象组成的数组。解析器合并实体片段，只投影决策所需字段。提供方对 Fantasy API 只发 GET；固定的 OAuth token 端点接收授权代码和刷新请求。提供方在独占的同级锁内重新读取存储，以 0600 临时文件写入，再重命名覆盖存储。响应缓存由 TTL 和条目上限约束。token 文件是唯一权威来源，缓存可派生且有界，因此不发布不变量组件。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Fantasy 子系统](../../../docs/subsystems/fantasy.zh.md) — 服务操作和球队解析。
- [模型工具](../tool-fantasy/README.zh.md) — 有界结果分页。

-----

<a id="model-experience"></a>
## 模型体验

### Yahoo 提供方

#### 模型看到的内容

提供方不注册模型模式或提示词。独立的 `fantasy` 消费方把只读结果投影到 Session；`/fantasy auth` 与 `/fantasy status` 是人工命令。

#### Token 影响

提供方自身不增加模型 token。OAuth 值不会进入模型结果。

#### KV Cache 影响

提供方不改变模型请求缓存。Yahoo 响应缓存是独立的。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 导入的 Python 缓存仅用于引导，不是共享刷新存储。
- Yahoo 响应中缺少的字段，包括部分球员预测和新闻，不会出现在规范化视图中。
- 账户所有者须进行 Yahoo 只读现场验证；夹具测试不联系 Yahoo。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
