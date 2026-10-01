---
description: "将 Sleeper 每周数据行预测转换为 Yahoo 统计项 id，供 Fantasy 消费方使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-fantasy-projections-sleeper

[English](README.md) | 中文

## 概述

使用 `ctx.fantasyProjections` 从 Sleeper 公开预测中为联盟球员预测每周数据行。提供方无需账户或密钥，将 Sleeper 统计键转换为 Yahoo 统计项 id，并按姓名、NFL 球队和位置匹配联盟球员，消费方可用 `scoreStats` 按其联盟计分规则为每行计分。

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

将提供方与 [fantasy-yahoo](../fantasy-yahoo/README.zh.md) 等 Fantasy 提供方一同装载。每个字段都有默认值，因此空 `config` 即可使用。

| Config | Default | Meaning |
|---|---|---|
| `baseUrl` | `https://api.sleeper.com` | 预测端点的 HTTPS 源 |
| `seasonType` | `regular` | Sleeper 赛季类型：`regular`、`pre` 或 `post` |
| `positions` | `QB`, `RB`, `WR`, `TE`, `K`, `DEF` | 请求的位置；不含其中任何位置的行永不匹配 |
| `cacheTtlMs` | `3600000` | 某一周的预测在请求开始后被复用的时长；`0` 表示每次都请求 |
| `requestTimeoutMs` | `20000` | 每个 Sleeper 请求的截止时间 |

`project(season, week, players)` 为每个已匹配且至少有一项预测数据的球员返回一行数据，以球员键为键。未匹配的球员（如 Sleeper 未列出的深度替补）以及其行没有任何预测的球员（如轮空球员）不在结果中。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

对 `/projections/nfl/<season>/<week>` 的一次 GET 返回该周所有预测行，约 3,300 行、2 MB。提供方按赛季和周保留一个请求 `cacheTtlMs` 时长；并发调用方共享进行中的请求，失败的请求会被遗忘以便下一个调用方重试，单个调用方的取消只拒绝该调用方。响应体不是数组时请求失败；缺少球员姓名、位置、球队或 stats 对象的行被跳过，非数值统计被丢弃。

固定的协议表将 Sleeper 键转换为 Yahoo 统计项 id。进攻球员和踢球员映射传球、冲球、接球、目标数、丢失的掉球、按距离划分的射门命中与未命中以及附加分；`pr_td` 加 `kr_td` 成为回攻达阵（15），三个两分转换键求和为 16。防守映射失分、擒杀、抄截、掉球回收、防守达阵、安全分和封阻踢球；`def_pr_td` 加 `def_kr_td`（两者都缺失时用 `st_td`）成为回攻达阵（49）；Sleeper 的失分档位标志映射到 50 至 56，没有任何档位标志的行取包含其 `pts_allow` 的档位。

姓名经 NFKD 规范化为 ASCII、转小写、去除句点和撇号、去掉 `jr`、`sr`、`ii`、`iii`、`iv` 和 `v` 并折叠其他分隔符后匹配。球员匹配规范化姓名和大写 NFL 球队都相同的唯一一行；否则匹配姓氏、球队相同且位置属于该球员位置之一的唯一一行。防守匹配其球队唯一的防守行。缓存派生自 Sleeper 响应，不拥有独立观测，因此不发布不变量组件。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Fantasy 定义](../fantasy/README.zh.md) — `FantasyProjectionService` 与 `scoreStats`。
- [每周报告](../fantasy-reports/README.zh.md) — 预测的消费方。

-----

<a id="model-experience"></a>
## 模型体验

### Sleeper 预测提供方

#### 模型看到的内容

提供方不注册任何 schema 或提示词。消费方在任何模型看到之前就用 `scoreStats` 把数据行换算成预测得分，例如每周报告事实卡中的 `projection` 字段。

#### Token 影响

提供方本身不增加模型 token。

#### KV Cache 影响

提供方不改变模型请求缓存。其预测缓存是独立的。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- Sleeper 的预测端点公开但无文档；响应结构变化会使请求失败或丢弃行，而不会产生错误的数据行。
- 没有对应 Sleeper 键的 Yahoo 统计项（如进攻掉球回收达阵）不在数据行中；Sleeper 2026 年第 5 周的响应没有 `kr_td`、`fgmiss_0_19` 或 `fgmiss_20_29` 键，档位标志只有 `pts_allow_21_27`。
- Sleeper 未列出的球员，以及同一 NFL 球队同一位置的同名球员，保持无预测。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
