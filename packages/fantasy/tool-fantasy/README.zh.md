---
description: "按调用方解析球队并提供有界 Yahoo Fantasy 模型读取。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-fantasy

[English](README.md) | 中文

## 概述

通过一个只读 `fantasy` 工具查询当前 Fantasy 信息。工具以有界页面返回联盟、设置、排名、预测对阵、阵容、球员搜索和可用状态、交易、选秀结果及比赛周。

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

装载 Fantasy 提供方和工具注册表。可选的 `pageChars` 范围为 100 到 32000，默认值为 8000。省略 `team` 键即可使用调用方配置的球队。球员读取需要搜索词或可用状态筛选；球员与交易的提供方分页使用 `start` 和 `count`，每页最多 25 条。球员结果包含 `sort_scope`：未请求排序时为 `none`，Yahoo 得分或排名排序为 `league`，持有率排序为 `page`。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

工具获取活跃调用方 Session，并通过提供方验证过的预设映射取得其球队。模型参数可选择其他显式联盟、球队或球员键，但不能选择调用方身份。使用方序列化规范化视图，按 Unicode 字符切分 JSON；`next_offset` 与 `total_chars` 用于续读长响应。每次工具结果进入普通 Session 工具历史。工具除注册外不拥有状态，因此不发布不变量组件。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Fantasy 提供方](../fantasy-yahoo/README.zh.md) — 账户 token 和 API 行为。
- [Fantasy 子系统](../../../docs/subsystems/fantasy.zh.md) — 只读视图与权限。

-----

<a id="model-experience"></a>
## 模型体验

### Fantasy 工具

#### 模型看到的内容

一个 `fantasy` 模式提供十一个只读动作。结果在 `text` 中包含规范化 JSON，`next_offset` 用于结果切片，`next_start` 用于 Yahoo 球员或交易分页。工具调用和结果进入调用方 Session。

#### Token 影响

每个结果最多包含 `pageChars` 个数据字符及较小的分页外壳。默认数据上限是 8000 字符。

#### KV Cache 影响

固定组合下模式保持稳定；每个返回页都会扩展调用方的工具历史。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 工具不能提交阵容调整、弃权认领、交易或其他 Yahoo 写入。
- 工具不从其他信息源合成伤病新闻；应另行查询注明日期的新闻。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
