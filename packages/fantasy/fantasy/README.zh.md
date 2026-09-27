---
description: "只读 Fantasy 服务类型及品牌化联盟、球队和球员键。"
kind: "package-reference"
---

# @deepseek-ai/dsh-fantasy

[English](README.md) | 中文

## 概述

使用 `ctx.fantasy` 读取联盟、计分规则、排名、对阵、阵容、球员、交易、选秀结果和比赛周。提供方负责数据；定义在键进入请求路径前验证联盟、球队和球员键。

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

使用方调用服务之前需装载 [fantasy-yahoo](../fantasy-yahoo/README.zh.md) 等提供方。活跃调用方 Session 通过 `teamFor` 选取配置的球队；模型参数不能选择调用方身份。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

抽象服务声明与提供方无关的只读方法和视图类型。联盟、球队和球员键是按 Yahoo 精确格式接纳的品牌化字符串。定义不发布不变量组件，因为它没有可变状态或独立观测值。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Fantasy 子系统](../../../docs/subsystems/fantasy.zh.md) — 数据关系与权限。
- [模型工具](../tool-fantasy/README.zh.md) — 有界模型结果。

-----

<a id="model-experience"></a>
## 模型体验

### Fantasy 服务

#### 模型看到的内容

此定义不注册模式或提示词。`fantasy` 消费方为调用方 Session 选择只读视图；`ctx.fantasy` 本身留在 Host。

#### Token 影响

定义不增加模型 token。

#### KV Cache 影响

定义不改变请求缓存。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 所有读取都需要提供方。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
