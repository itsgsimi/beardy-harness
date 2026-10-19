---
description: "为 Fantasy 消费方提供 nflverse 的 NFL 赛程、博彩盘口和已完赛使用率。"
kind: "package-reference"
---

# @deepseek-ai/dsh-fantasy-nflverse

[English](README.md) | 中文

## 概述

使用 `ctx.fantasyNfl` 读取每个常规赛周的 NFL 比赛（含开球时间、让分、总分盘和球场顶棚）以及联盟球员的已完赛使用率：目标数、目标份额、接球数、持球数和进攻回合占比。提供方读取 nflverse 的公开 CSV 文件，无需账户或密钥，并按姓名、NFL 球队和位置匹配联盟球员。

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

将提供方与 [fantasy-yahoo](../fantasy-yahoo/README.zh.md) 等 Fantasy 提供方一同装载。每个字段都有默认值，因此空 `config` 即可使用。URL 必须是不含凭据的 HTTPS 地址，两个模板都必须包含 `{season}`，它会被替换为赛季年份；未通过这些检查的 URL 会使插件在加载时失败。

| Config | Default | Meaning |
|---|---|---|
| `scheduleUrl` | `https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv` | 全部赛季的赛程 CSV |
| `statsUrlTemplate` | `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_{season}.csv` | 单个赛季的每周球员统计 CSV |
| `snapsUrlTemplate` | `https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_{season}.csv` | 单个赛季的攻防回合数 CSV |
| `cacheTtlMs` | `21600000` | 单个文件在请求开始后被复用的时长，从 `0`（每次都请求）到 24 小时 |
| `requestTimeoutMs` | `60000` | 每个请求（含读取响应体）的截止时间 |
| `maxResponseBytes` | `20971520` | 可接受的最大响应体；更大的响应体使请求失败 |

`games(season, week)` 按赛程顺序返回该周的常规赛比赛；轮空球队不在结果中。`kickoff` 是 ISO 8601 UTC 时间戳，`homeSpread` 是主队被看好的分差，`total` 是总分盘。球队缩写为大写并与 Yahoo 一致，因此公羊队是 `LAR`。赛程留空的盘口或顶棚不在结果中。

`usage(season, weeks, players)` 为每名已匹配的球员，按周顺序返回其在所请求各周中有统计行或回合行的每一周的一行。每行包含 `week`、`team`、`opponent`，以及文件提供的 `targets`、`targetShare`、`receptions`、`carries` 和 `snapShare`；份额取值为 0 到 1。踢球员、防守和未匹配的球员不在结果中。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

赛程是包含所有赛季的单个文件，约 2.2 MB；每周统计（约 2.9 MB）和攻防回合数（约 0.7 MB）每个赛季一个文件。提供方按 URL 保留一个请求 `cacheTtlMs` 时长；并发调用方共享进行中的请求，失败的请求会被遗忘以便下一个调用方重试，单个调用方的取消只拒绝该调用方。传输错误、非成功状态、重定向到非 HTTPS URL、响应体超过 `maxResponseBytes` 或文件缺少必需列时请求失败；错误只写明文件和状态，从不包含响应体。

`papaparse` 按表头行读取每个文件并跳过空行。只计入常规赛行：`game_type` 为 `REG` 的赛程行和回合行，以及 `season_type` 为 `REG` 的统计行。缺少赛季、周、球队或 `YYYY-MM-DD` 日期与 `HH:MM` 时间的赛程行被跳过。赛程以美国东部墙钟时间书写时间，因此开球时间换算通过 `Intl` 应用该日期生效的 `America/New_York` 偏移，11 月夏令时结束后的比赛取标准时间偏移。`spread_line` 成为 `homeSpread`，`total_line` 成为 `total`，nflverse 的 `LA` 成为 `LAR`。

姓名通过 [fantasy](../fantasy/README.zh.md) 的 `normalizePlayerName` 匹配。每一周，球员匹配规范化姓名相同、位置属于其位置之一且 NFL 球队相同的唯一统计行；该周没有任何行属于其球队时（如交易之后），匹配姓名相同且位置属于其位置之一的唯一行。回合行以同样方式按 `player`、`position` 和 `team` 匹配，并以 `offense_pct` 提供 `snapShare`。球队和对手取自统计行，该周没有统计行时取自回合行。缓存派生自 nflverse 响应，不拥有独立观测，因此不发布不变量组件。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Fantasy 定义](../fantasy/README.zh.md) — `FantasyNflService`、`FantasyNflGame` 与 `FantasyNflUsage`。
- [每周报告](../fantasy-reports/README.zh.md) — NFL 数据的消费方。

-----

<a id="model-experience"></a>
## 模型体验

### nflverse NFL 数据提供方

#### 模型看到的内容

提供方不注册任何 schema 或提示词。消费方在任何模型看到之前就把比赛和使用率转换为报告事实，例如由 `homeSpread` 和 `total` 算出的隐含球队得分，以及 `snapShare` 值。

#### Token 影响

提供方本身不增加模型 token。

#### KV Cache 影响

提供方不改变模型请求缓存。其文件缓存是独立的。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- nflverse 在比赛结束后发布统计和攻防回合数，回合数可能比统计晚一周；没有文件行的周不在结果中或缺少 `snapShare`。
- 这些文件公开且由社区维护；列被改名会使请求失败，而不会产生错误的行。
- 同一 NFL 球队同一位置的同名球员，以及 Yahoo 与 nflverse 位置不同的球员（如被列为跑卫的全卫），保持未匹配。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
