---
description: "Yahoo Fantasy 的只读服务、提供方与模型工具。"
kind: "package-group"
---

# packages/fantasy

[English](README.md) | 中文

## Summary

通过一个服务读取 Yahoo Fantasy 联盟与球队的当前信息，通过另一个服务读取每周球员预测。Yahoo 提供方管理私有 OAuth 存储；Sleeper 提供方提供预测数据行；模型工具返回有界且记录在 Session 中的只读结果；报告插件定时发送经过审阅的每周报告。

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [fantasy](fantasy/README.zh.md) | 品牌化键、只读视图和预测计分 | `ctx.fantasy` 与 `ctx.fantasyProjections` 定义 |
| [fantasy-yahoo](fantasy-yahoo/README.zh.md) | Yahoo v2 API 和私有 OAuth 存储 | `ctx.fantasy` 提供方 |
| [fantasy-projections-sleeper](fantasy-projections-sleeper/README.zh.md) | Sleeper 每周数据行预测 | `ctx.fantasyProjections` 提供方 |
| [tool-fantasy](tool-fantasy/README.zh.md) | 有界的 `fantasy` 模型工具 | 服务使用方 |
| [fantasy-reports](fantasy-reports/README.zh.md) | 通过研究运行定时生成每周报告 | 服务使用方 |

-----

<a id="related-documentation"></a>
## Related documentation

- [Fantasy 子系统](../../docs/subsystems/fantasy.zh.md) — 读取、所有权和调用方球队解析。

-----

<a id="dev-note"></a>
## Dev Note

无。
