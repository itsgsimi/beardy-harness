---
description: "通过已配置的 Harness Web 提供方获取 wttr.in 当前天气和短期预报，并由部署选择默认地点与单位。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-weather

[English](README.md) | 中文

## 概述

有 Harness Web 抓取提供方时，使用 `get_weather` 获取当前天气和短期预报。部署选择默认地点、单位和预报天数；调用也可以指定其他地点。wttr.in 的 `j1` 响应最多提供三天，因此此工具不承诺五天预报。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将工具与 `dsh-tools`、`dsh-web` 及抓取提供方一同挂载。Beardy 组合包提供以 Phoenix 为默认地点的条目；个人 profile 可以替换其配置。

```yaml
- id: tool-weather
  name: '@deepseek-ai/dsh-tool-weather'
  config:
    defaultLocation: Phoenix, AZ
    units: us
    days: 3
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `defaultLocation` | 必填 | 模型省略 `city` 时使用的地点。 |
| `units` | `us` | `us` 返回华氏度和英里每小时；`metric` 返回摄氏度和公里每小时。 |
| `days` | `3` | 预报天数，范围为一至三天。 |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-weather)列出可接受的字段。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

工具编码请求地点，经 `ctx.web` 抓取 `https://wttr.in/<location>?format=j1`，并投影为有界 JSON 结果。提供方收到工具的取消信号。HTTP 失败、截断响应、无效 JSON 和缺失当前天气都会使工具调用失败。工具不持有网络客户端、缓存或后台任务。工具注册表在 Session 日志中记录调用和渲染后的结果。此包没有独立的状态投影，因此不发布 invariant 伴随模块。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Web 能力](../web/README.zh.md)——提供方选择和抓取结果。
- [Web 工具](../tool-web/README.zh.md)——通用搜索和抓取。
- [Beardy 组合包](../../bundle/beardy/README.zh.md)——随附的天气条目。

-----

<a id="model-experience"></a>
## 模型体验

### 天气请求

#### 模型会看到什么

模型会看到带可选 `city` 参数的 `get_weather`；[生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-weather)说明 `j1` 的三天限制。成功调用以 JSON 返回解析出的地点、观测时间、所选单位、当前天气和不超过配置天数的每日预报。失败表现为普通工具错误。

#### Token 影响

挂载后存在一个工具 schema。每次调用向 Session 历史添加一份有界结果或错误。

#### KV Cache 影响

同一已挂载 profile 的 schema 稳定；每份不同的结果添加新的历史内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- wttr.in `j1` 最多提供三天预报。
- 预报单元和可选测量值可能缺失；结果对缺失的投影字段使用 `null`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作记录——点击展开</summary>

无。

</details>
