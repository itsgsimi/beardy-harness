# Agent Note：为 fantasy 报告引入 Sleeper 预测

状态：已实现

[English](2026-10-01-fantasy-sleeper-projections.md) | 中文

## 问题

每周 fantasy 报告按 `FantasyPlayer.projectedPoints` 排列阵容、接近的抉择和自由球员差距，但 Yahoo 公开的 Fantasy API 不返回逐名球员的预测：每周阵容读取只带实际统计，只有球队总分带预测，所有请求预测统计的变体都被拒绝。因此实时报告不会显示球员预测，会保留当前 Yahoo 首发，接近的抉择也只来自状态不确定的首发。

## 决策

`dsh-fantasy` 新增第二个 Service Definition `FantasyProjectionService`（`ctx.fantasyProjections`），只有一个方法 `project(season, week, players, signal)`，返回以球员键为键、使用 `FantasyScoringStat.id` 统计项 id 的预测数据行；未匹配的球员不在结果中。纯函数 `scoreStats(stats, scoring)` 按联盟计分规则为数据行计分。返回数据行而非分数，使联盟计分规则仍由联盟提供方掌握，任何消费方都能自行计分。

`dsh-fantasy-projections-sleeper` 从 Sleeper 免费公开端点提供该服务，每个赛季和周一次 GET，缓存 `cacheTtlMs` 并由并发调用方共享。固定的协议表把 Sleeper 统计键转换为 Yahoo 统计项 id；防守使用单独的表，因此防守行的 `pr_td` 不会重复计入其回攻达阵，没有失分档位标志的行取包含其 `pts_allow` 的档位。球员先按规范化姓名和大写 NFL 球队匹配，再按唯一的姓氏、球队和位置匹配；防守按球队匹配。对照 Sleeper 2026 年第 5 周的响应，一个联盟的 416 名 Yahoo 球员中有 384 名匹配，未匹配的是未列出的替补和踢球员；在该联盟计分规则下，每条已匹配的非踢球员、非防守数据行得分与 Sleeper 的半 PPR 总分相差不超过一分。

`dsh-fantasy-reports` 要求注入 `fantasyProjections`，对阵容、每份自由球员名单和对手阵容各调用一次，只在 Yahoo 未给出 `projectedPoints` 时设置它。预测读取失败会添加一条注意事项，并让该名单保持无预测。报告和提示词中球员层面的文字说“projected”，不再说“Yahoo projects”；球队总分仍来自 Yahoo。提示词版本保持 `fantasy-weekly-v6`，因为 v6 尚未发布。

## 考虑过的替代方案

- **用其他统计类型向 Yahoo 请求预测** — 已拒绝，因为实时检查中所有预测统计变体都返回 HTTP 400。
- **返回预测分数而非数据行** — 已拒绝，因为分数取决于联盟计分规则，而计分规则由联盟提供方掌握，每个消费方都需要预测提供方了解它。
- **抓取 FantasyPros 等预测网站** — 已拒绝，因为 Sleeper 的 JSON 端点无需解析 HTML 或密钥，并带有完整数据行。
- **让报告的预测服务成为可选** — 已拒绝，因为没有预测的报告会悄然削弱每个阵容决定；必需注入会在缺少提供方条目时明确失败。

## 影响

实时报告按预测排列阵容和自由球员差距，也会出现基于预测的接近抉择。报告依赖一个无文档的公开端点；结构变化会使读取失败，报告会在注意事项中说明。预测分数来自 Sleeper，对阵总分来自 Yahoo，因此逐位比较的合计未必等于对阵行。加载报告的部署也必须启用提供方条目；Beardy bundle 在报告条目旁以禁用状态附带它。
