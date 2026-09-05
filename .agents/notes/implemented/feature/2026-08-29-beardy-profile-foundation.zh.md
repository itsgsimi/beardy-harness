# Agent Note：Beardy profile 基础

Status: implemented

[English](2026-08-29-beardy-profile-foundation.md) | 中文

## 问题

DeepSeek Harness 已经提供了构建类似 Hermes 的编码与研究 agent 所需的插件接缝，但随发行版交付的 profile 尚未把这些接缝组合成一个具名产品表层。会话历史搜索、面向模型的历史工具、Web 抓取与产品身份分散在不同条目或可选层中。把它们启用到 base profile 会改变所有应用，而增加第二个 launcher 又会绕过 profile 与组合包架构。

## 决策

以 `beardy` profile 与 `@deepseek-ai/dsh-beardy` 组合包交付 Beardy。该 profile 组合 `dsh-base`、`dsh-web-app` 与 Beardy patch 层，并使用实时 patch 重载。Beardy patch 选择随附的 Beardy preset，为 `web_search` 选择 SearXNG，禁用 base 的 DeepSeek 搜索行，启用 Web 抓取，插入五个会话历史工具，并把持久化的派生 SQLite 搜索索引配置为 `$DSH_HOME/session-search.sqlite`，在第一次搜索时打开。搜索数据库与会话持久化数据库保持分离。

该组合包是没有运行时服务或可变状态的 patch 载体。其包清单声明 patch 使用的包，包括 SearXNG 提供方，launcher 负责 `beardy` 模板，因此 Harness 上游更新仍会沿用正常的组合包/profile 叠加关系。SearXNG 提供方使用配置的 `GET /search?format=json` 端点，不需要厂商 API 密钥。Beardy preset 使用只读组装 include 继承 Creator mode，而 Creator mode 继承完整的 `standard` 能力清单并增加实时 Cordis 创作工具与组装 skill。Beardy 只覆盖自己的 scoped persona 与用户全局指令候选。base 已提供的 skill、goal、workflow、subagent、shell、filesystem 与 approval 行为继续由现有包负责。

## Alternatives considered

#### 为什么不把历史与 Web 条目启用在 `dsh-base` 中？

这样会让 Beardy 专用的搜索索引、历史工具与抓取行为成为每个随附应用的一部分，包括一次性应用、SDK 与 ACP profile。具名 profile 可以让产品表层按需启用，同时保留现有 base 组合。

#### 为什么不创建独立的 Beardy launcher？

新的 launcher 会重复 profile 解析、patch 优先级、包发现与应用入口策略。组合包与 profile 使用现有扩展路径，让上游 launcher 的变更与 Beardy 行为保持隔离。

#### 为什么不修改 `agent-loop` 以支持 Beardy？

第一版 Beardy 需要组合能力与持久历史访问，而不是第二套循环实现。把行为保留在 system-prompt、能力与工具条目中，可以让 Harness 循环继续作为共享执行主干。

## 后果

用户可以使用 `dsh --profile beardy` 启动随附 agent，也可以把组合包添加到其他 profile。Beardy 保留 standard agent 的工具与提示词能力，可以检查并临时扩展正在运行的 Cordis，可以搜索持久化的会话历史与配置的 SearXNG 实例并抓取 Web 页面，同时所有面向模型的输入仍由现有且会记录日志的能力产生。持久化的 Harness 或用户 preset 修改仍使用 shell 与 filesystem 工具，并遵循组装创作 skill 的归属规则。`$DSH_HOME/SOUL.md` 为 Beardy 会话提供可编辑的个性指引，不改变其他 profile。该 profile 目前不提供独立的个人记忆存储、自动 skill 整理器、跨会话调度器或消息网关；这些仍是独立能力，而不是隐式的 Beardy 行为。

专用搜索索引是持久化的派生状态，不得指向会话持久化数据库。SearXNG 是 Web 搜索的外部前置条件：其端点必须公开 `GET /search?format=json`，Beardy 默认使用 `http://127.0.0.1:8080`。全局 Soul 文件使用正常的持久 workspace-instruction 路径，并低于更高优先级指令。由于 Creator mode 继承 standard 清单且 Beardy 继承 Creator mode，未来合并 Harness 更新时可以先更新底层组合包，只在行 id 或配置发生变化时调整明确的 Beardy 覆盖项。
