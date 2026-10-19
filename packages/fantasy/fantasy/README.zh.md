---
description: "只读 Fantasy 与预测服务类型、数据行计分，以及品牌化联盟、球队和球员键。"
kind: "package-reference"
---

# @deepseek-ai/dsh-fantasy

[English](README.md) | 中文

## 概述

使用 `ctx.fantasy` 读取联盟、计分规则、排名、对阵、阵容、球员、交易、选秀结果和比赛周。提供方负责数据；定义在键进入请求路径前验证联盟、球队和球员键。使用 `ctx.fantasyProjections` 为联盟球员预测每周数据行，使用 `scoreStats` 按联盟计分规则为数据行计分。使用 `ctx.fantasyNfl` 读取 NFL 比赛、博彩盘口和已完成比赛的使用数据，使用 `normalizePlayerName` 跨数据源匹配球员姓名。

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

`players(league, query)` 读取一页。`status` 为 `FA` 时选择可立即签入的球员，`W` 选择需要认领的球员，`A` 两者都选；每名球员的 `ownershipType` 为 `team`、`waivers` 或 `freeagents`。`playerKeys` 读取至多 25 名指定球员，并排除 `search`、`status`、`position` 和 `sort`；`week` 仍选择统计周。`percentOwnedDelta` 是持有率的变化。`FantasyTeam` 带有 `waiverPriority`（1 最先认领）、有预算联盟中的 `faabBalance`，以及赛季签入与裁出次数 `moves`。`FantasyLeagueSettings` 带有 `waiverDays` 和 `usesFaab`。联盟当前允许球员进入 IR 位置时，`positions` 包含 `IR`。

使用方调用 `ctx.fantasyProjections.project(season, week, players)` 之前需装载 [fantasy-projections-sleeper](../fantasy-projections-sleeper/README.zh.md) 等预测提供方。它返回以球员键为键的预测数据行，统计项 id 与 `FantasyScoringStat.id` 和 `FantasyPlayer.stats` 相同；无法匹配的球员不在结果中。`scoreStats(line, scoring)` 对带分值的计分项求统计值与分值之积的和，并四舍五入到百分位。

使用方调用 `ctx.fantasyNfl` 之前需装载 `@deepseek-ai/dsh-fantasy-nflverse` 等 NFL 数据提供方。`games(season, week)` 返回该周的 `FantasyNflGame` 行，包含 UTC 开球时间、主客队，以及已公布的主队让分、总分和场馆顶棚；轮空球队不在结果中。`usage(season, weeks, players)` 按球员键返回按周排序的 `FantasyNflUsage` 行，包含目标数、目标占比、接球数、持球数和进攻 snap 占比；无法匹配的球员和未进行的比赛不在结果中。球队缩写为大写，与 `FantasyPlayer.nflTeam` 不区分大小写比较。`normalizePlayerName(name)` 将重音字母折叠为 ASCII、转为小写、删除句点和撇号、去掉 `Jr`、`Sr` 以及 `II` 到 `V`，并用单个空格连接其余单词。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

抽象服务声明与提供方无关的只读方法、预测方法和视图类型。联盟、球队和球员键是按 Yahoo 精确格式接纳的品牌化字符串。定义不发布不变量组件，因为它没有可变状态或独立观测值。

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

- 所有读取都需要提供方，所有预测都需要预测提供方，所有 NFL 数据读取都需要 NFL 数据提供方。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
