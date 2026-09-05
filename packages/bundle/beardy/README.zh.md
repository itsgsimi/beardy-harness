---
description: "Beardy agent profile 组合包：带持久会话搜索、SearXNG 搜索与研究抓取能力的持久化、历史感知 Web agent。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-beardy

[English](README.md) | 中文

## 概述

Beardy 组合包在 `dsh-base` 与 `dsh-web-app` 之上添加持久化、具备历史感知能力的 agent profile。随发行版交付的 `beardy` profile 会自动包含它，并在 Harness home 下保存专用的会话搜索索引。Beardy 继承完整的 Creator mode 能力清单，包括 standard 编码工具与 Cordis 实时创作工具，再增加自己的身份、`$DSH_HOME/SOUL.md` 个性文件、会话搜索、SearXNG 支持的 Web 搜索与 Web 抓取。它可以在无需 DeepSeek 搜索凭证的情况下搜索早期会话与 Web，检查事件与 lineage，抓取 Web 页面，修改可访问的 Harness 源码与 preset，并临时扩展正在运行的进程。本组合包不提供个人持久记忆、自动 skill 整理、跨会话调度或消息适配器。

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

### 运行随附的 Beardy profile

安装会从 base、Web 与 Beardy 组合包层自动初始化 `beardy` profile：

```sh
dsh --profile beardy --dump-default-config
dsh --profile beardy
```

该 profile 使用实时 patch 重载，把专用的派生搜索索引保存到 `$DSH_HOME/session-search.sqlite`，并在第一次搜索时打开 SQLite。profile 自身与 home 层的 patch 文件可以按照常规 profile 分层规则替换这些行。

Beardy 默认把 `web_search` 发送到 `http://127.0.0.1:8080` 的 SearXNG JSON 端点。启动前设置 `SEARXNG_BASE_URL` 可以使用其他实例；并且必须在该实例的 `search.formats` 配置中启用 `json` 格式。端点约定见 [SearXNG 提供方 README](../../web/web-search-searxng/README.zh.md) 与 [SearXNG Search API](https://docs.searxng.org/dev/search_api.html)。

### 将组合包添加到其他 profile

当其他应用表层需要 Beardy 默认值时，把组合包安装到自定义 profile：

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-beardy
```

该组合包贡献一个 patch 层；它不是库，也不是应用 bin。后续 profile、home 与 `--patch` 层按 id 替换它的行；替换行必须重述要保留的完整配置。

### 你得到什么

- Beardy persona 将 agent 标识为温和务实的编码与研究 agent。
- `$DSH_HOME/SOUL.md` 提供可编辑的 Beardy 个性，不替代项目的 `AGENTS.md` 或 `CLAUDE.md` 指令。
- 完整的 Creator mode 能力清单仍然可用，并通过继承获得而非重复定义。
- Creator mode 的 Cordis 检查、临时 package 与组装创作能力对 Beardy 可用。
- 持久化 SQLite 全文搜索覆盖已保存的会话历史，不使用会话持久化数据库。
- 五个带 workspace 授权的会话历史工具让模型搜索、追踪并读取早期工作。
- 启用 SearXNG 支持的 Web 搜索与 Web 抓取，无需 DeepSeek 搜索凭证。
- 现有 DSH 的安全、skill、goal、workflow、subagent、shell、filesystem 与 approval 行为仍由各自所属的包组合提供。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

该 patch 选择随附的 `beardy` agent preset，覆盖 `session-query-sqlite`，选择 `searxng` web 提供方，禁用 DeepSeek 搜索行，启用 `tool-web`，然后插入 `tool-session-query`。Beardy preset 使用只读的 `agent-presets` include 行，在 Creator mode 之上叠加自己的身份与全局 `SOUL.md` 候选；Creator mode 再继承 standard 清单并增加自修改工具与 skill。SearXNG 负责 Web 搜索传输与结果映射，搜索后端拥有独立的派生 SQLite 数据库；历史工具消费方负责模型可见的 schema、指导语句与 workspace 授权。本组合包自身不提供运行时服务，也不持有可变状态。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Beardy 在 base 与 Web 组合包之上的 patch 层 |
| [`src/index.ts`](src/index.ts) | 包入口；不携带运行时 API |
| [`src/invariant.ts`](src/invariant.ts) | 静态 patch 载体的空不变式伴生插件 |
| [`tests/beardy.spec.ts`](tests/beardy.spec.ts) | manifest、patch、依赖与默认值检查 |

### 不变式归属

本组合包不注册运行时不变式，因为它只替换并插入由其他包负责的行。每个运行时包检查自己的服务、事件与持久化关系。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [组合包包映射](../README.zh.md)——DSH 随附的 profile 层。
- [app-boot profile 约定](../../boot/app-boot/README.zh.md)——profile 初始化与 patch 优先级。
- [Session query 包](../../session-query/tool-session-query/README.zh.md)——Beardy 向模型公开的历史工具。
- [SQLite 搜索后端](../../session-query/session-query-sqlite/README.zh.md)——持久化派生索引。
- [生成组合图](../../../apps/cli/composition.md)——每个随附 profile 的确切行。

-----

<a id="model-experience"></a>
## 模型体验

### Beardy system prompt

#### What the model sees

该 profile 在 base 的提示词段落与所选工具之前贡献一个稳定 persona。运行时为当前进程解析 `{{model}}` 与 `{{cwd}}`。

##### Persona text

```markdown
You are Beardy, a warmly pragmatic coding and research agent powered by the {{model}} model. Your working directory is {{cwd}}.
```

#### Token effect

一个简短且稳定的 persona，加上依赖数据的 base 提示词段落与所选工具 schema。

#### KV Cache effect

对于固定的 profile、provider、model 与工具清单保持稳定。只有 profile 组合或模型上下文改变时 persona 才会变化。

### Harness 创作

#### 模型看到的内容

Beardy 也获得 Creator mode 的 Cordis 检查与临时 package 工具，以及 `editing-cordis-compositions` skill。Shell 与 filesystem 工具仍是持久修改源码或用户 preset 的路径；动态 Cordis package 会在停止或 DSH 重启时消失。

#### Token 影响

创作工具会向模型上下文增加稳定的 schema 与指导。运行时 package 的代码与注册内容只在该 package 运行期间增加依赖数据的内容。

#### KV Cache 影响

对于固定 profile，创作工具 schema 与指导保持稳定。启动或停止动态 package 后，如果该 package 贡献了工具或提示词段落，后续请求前缀会改变。

### SOUL.md 个性

#### 模型看到的内容

Beardy 将 `$DSH_HOME/SOUL.md` 与 `$DSH_HOME/AGENTS.md` 一起作为持久全局指令加载。该文件包含语气、主动性、不确定性、异议、连续性与简洁偏好；它不授予权限，也不替代项目指令。

#### Token 影响

该文件使用正常的 workspace-instruction 预算，并像其他指令文件一样保留在持久会话历史中。

#### KV Cache 影响

对于固定 workspace，文件内容保持稳定；编辑文件会改变后续请求的指令前缀。

### Session history tools、Web search 与 Web fetch

#### What the model sees

该 profile 增加来自 [`dsh-tool-session-query`](../../session-query/tool-session-query/README.zh.md) 的五个只读历史工具 schema 与指导语句，包括生成的 [`session_search`、`session_event_search`、`session_trace`、`session_event_trace` 与 `session_event_read` schema`](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-session-query)。现有 Web 工具通过配置的 SearXNG 端点搜索，并通过匿名 HTTP 提供方抓取；确切的 schema 与结果文本由所属包提供。

#### Token effect

组合包挂载时会出现五个稳定的历史工具 schema 与一段简短指导语句。搜索、trace、事件与抓取结果是依赖数据的内容，会追加到已记录的会话中。

#### KV Cache effect

对于固定的组合包与配置，历史指导语句与工具 schema 保持前缀稳定。搜索与抓取结果会追加在这个可复用前缀之后。


## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **没有个人记忆存储**——Beardy 可以搜索会话历史，但目前不会维护单独整理的用户或项目记忆。
- **没有自动 skill 整理器**——skill 由 base 的 skill 包发现和加载；Beardy 不会自动编写或改进 skill。
- **没有跨会话调度器**——现有的 session-local schedule 仍是唯一的定时提醒行为。
- **没有消息网关**——该 profile 提供 Web 应用，但没有 Telegram、Discord、Slack 或类似的渠道适配器。
- **搜索使用独立数据库**——不要把 `session-query-sqlite.path` 指向会话持久化数据库。
- **SearXNG 是外部前置条件**——默认本地端点必须运行，并在 Beardy 使用 `web_search` 前公开 JSON 响应格式。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
