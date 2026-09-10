---
description: "Beardy agent profile 组合包：带策展记忆、持久会话搜索、SearXNG 搜索、研究抓取与按 token 门控的 Discord 投递能力的持久化、历史感知 Web agent。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-beardy

[English](README.md) | 中文

Odysseus 深度研究需显式启用：在个人配置档补丁中启用默认禁用的 `tool-odysseus-research` 条目，并根据[研究桥接配置](../../web/tool-odysseus-research/README.zh.md)选择服务器、研究令牌、端点、模型和预算。

## 概述

Beardy 组合包在 `dsh-base` 与 `dsh-web-app` 之上添加持久化、具备历史感知能力的 agent profile。随发行版交付的 `beardy` profile 会自动包含它，并在 Harness home 下保存专用的会话搜索索引。Beardy 继承完整的 Creator mode 能力清单，包括 standard 编码工具与 Cordis 实时创作工具，再增加自己的身份、`$DSH_HOME/SOUL.md` 个性文件、跨会话的策展记忆（由单一 `memory` 工具管理的 `$DSH_HOME/USER.md` 与 `MEMORY.md`）、会话搜索、对话时钟、SearXNG 支持的 Web 搜索与 Web 抓取。定时运行与 Discord 投递来自 `dsh-cron`、`dsh-tool-discord` 与 `dsh-discord-gateway`；patch 把这三行挡在 `DISCORD_BOT_TOKEN` 凭据之后，且不随包交付任何 cron 任务。你自己的简报、渠道目的地、网关工作区与权限预设由你的 profile patch（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`）提供；被启用却缺少该配置的行会在 schema 检查处响亮失败，而不是按默认值运行。

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

该 profile 使用 patch 实时热重载，把专用的派生搜索索引存放在 `$DSH_HOME/session-search.sqlite`，并在首次搜索时打开 SQLite。profile 自身与 home 层的 patch 文件可以按普通的 profile 层规则替换这些行。

Beardy 默认把 `web_search` 发往 `http://127.0.0.1:8080` 的 SearXNG JSON 端点。启动前设置 `SEARXNG_BASE_URL` 可改用其他实例，并在该实例的 `search.formats` 配置中启用 `json` 格式。端点契约见 [SearXNG provider README](../../web/web-search-searxng/README.zh.md) 与 [SearXNG Search API](https://docs.searxng.org/dev/search_api.html)。

### 部署为常驻的 Discord agent

组合包只在进程环境中存在 `DISCORD_BOT_TOKEN` 时才挂载具备 Discord 能力的三行，并且刻意不携带任何目的地或权限值。部署方用一个环境文件和一个 profile patch 层提供这些值。

把非机密的引用与标识符放进一个环境文件（权限 `0600`，绝不入库）：

```sh
DISCORD_BOT_TOKEN=...
DISCORD_CHANNEL_ID=<channel snowflake that discord_send targets>
DISCORD_DM_USER_IDS=<user ids allowed as direct-message targets>
DISCORD_ALLOWED_USER_IDS=<user ids whose inbound messages the gateway answers>
SEARXNG_BASE_URL=http://127.0.0.1:8080
```

然后把部署所需的行加入 `$DSH_HOME/profiles/beardy/cordis.patch.yml`。`- id:` 行会整体替换该行的配置，因此必须重述你要保留的每个字段：

```yaml
- id: tool-discord
  config:
    tokenEnv: DISCORD_BOT_TOKEN
    channelId: !!js process.env.DISCORD_CHANNEL_ID
    dmUserIds: !!js (process.env.DISCORD_DM_USER_IDS || '').split(' ').filter(Boolean)

- id: discord-gateway
  config:
    tokenEnv: DISCORD_BOT_TOKEN
    allowedUserIds: !!js (process.env.DISCORD_ALLOWED_USER_IDS || '').split(' ').filter(Boolean)
    workspacePath: /srv/beardy-workspace
    agentPreset: beardy-discord
    permissionPreset: danger-full-access

- id: cron
  config:
    jobs:
      - name: morning-brief
        expression: '0 7 * * *'
        timezone: Europe/Zagreb
        agentPreset: beardy-unattended
        permissionPreset: workspace-write
        workspacePath: /srv/beardy-workspace
        deliverChannel: !!js process.env.DISCORD_CHANNEL_ID
        prompt: Prepare the morning brief.
```

用 systemd 运行它，使其在注销与重启后存活：

```ini
[Unit]
Description=Beardy persistent agent (dsh web)
After=network-online.target

[Service]
WorkingDirectory=/srv/deepseek-harness
EnvironmentFile=/etc/beardy/environment
ExecStart=/usr/bin/env pnpm dsh --profile beardy
Restart=always

[Install]
WantedBy=multi-user.target
```

随发行版交付的三个 Beardy preset 划分了角色：Web 中启动的会话使用 `beardy`，网关对话运行 `beardy-discord`（简洁 Markdown 回复，记忆写入提交审批），cron 任务运行 `beardy-unattended`（遵循任务的投递指令，关闭创作类工具）。[Discord 网关](../../discord/discord-gateway/README.zh.md)提供原生命令菜单、审批按钮、选项菜单、进度反馈与持久回复投递。启用却缺少 profile 配置的行会在加载时失败并点名必填字段。

### 把组合包加入其他 profile

当另一个应用界面需要 Beardy 的默认值时，把组合包装入自定义 profile：

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-beardy
```

组合包贡献的是一个 patch 层；它不是库，也不是应用 bin。后续的 profile、home 与 `--patch` 层会按 id 替换其行，而替换一行必须重述它要保留的完整配置。

### 你将获得

- Beardy persona 把 agent 标识为一个务实温和的编码与研究 agent。
- `$DSH_HOME/SOUL.md` 提供可编辑的 Beardy 个性，且不会取代项目的 `AGENTS.md` 或 `CLAUDE.md` 指令。
- 跨会话的策展记忆：`memory` 工具编辑 `$DSH_HOME/USER.md` 与 `MEMORY.md`，两个文件随后作为 user-global 指令加载进之后的会话。
- 对话时钟（`dsh-time-context`）为跨越数天的对话解析相对时间，持久注入按小时节流。
- 完整的 Creator mode 能力清单依然可用，且以继承方式获得而非复制。
- Beardy 可以使用 Creator mode 的 Cordis 检查、临时 package 与组装创作能力。
- 持久的 SQLite 全文搜索覆盖已持久化的会话历史，且不使用 session-persistence 数据库。
- 五个经工作区授权的会话历史工具让模型可以搜索、追踪并阅读先前的工作。
- SearXNG 支持的 Web 搜索与 Web 抓取无需 DeepSeek 搜索凭证即可启用。
- DSH 既有的安全、skill、goal、workflow、subagent、shell、文件系统与审批行为仍由其归属包组装。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

patch 选择随发行版交付的 `beardy` agent preset，覆盖 `session-query-sqlite`，选择 `searxng` web provider，禁用 DeepSeek 搜索行，启用 `tool-web`，并插入 `tool-session-query`、`time-context` 以及按 token 门控的 `tool-discord`、`discord-gateway` 与 `cron` 行。Beardy preset 通过只读的 `agent-presets` include 行把自身身份、作为全局指令候选的策展记忆文件以及 `memory` 工具叠加到 Creator mode 之上；`beardy-unattended` 与 `beardy-discord` 由它派生，各自附加 persona 语句并收紧 `memory` 的审批。SearXNG 负责 Web 搜索传输与结果映射，搜索后端持有独立的派生 SQLite 数据库，历史工具 Consumer 负责面向模型的 schema、指引与工作区授权。组合包自身不持有任何运行时服务或可变状态。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Beardy 在 base 与 Web 组合包之上的 patch 层 |
| [`src/index.ts`](src/index.ts) | 包入口；不携带运行时 API |
| [`src/invariant.ts`](src/invariant.ts) | 静态 patch 载体对应的空 invariant companion |
| [`tests/beardy.spec.ts`](tests/beardy.spec.ts) | manifest、patch、依赖与默认值检查 |
| [`tests/composition.spec.ts`](tests/composition.spec.ts) | token 门控、零部署数据与必填字段失败检查 |

### Invariant 归属

组合包不注册任何运行时 invariant，因为它只替换和插入由其他包拥有的行。每个运行时包各自检查自己的服务、事件与持久化关系。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Bundle package map](../README.zh.md) — DSH 随附的各 profile 层。
- [app-boot profile contract](../../boot/app-boot/README.zh.md) — profile 初始化与 patch 优先级。
- [Memory tool package](../../memory/tool-memory/README.zh.md) — 策展的 `USER.md` / `MEMORY.md` 编辑器。
- [Session query package](../../session-query/tool-session-query/README.zh.md) — Beardy 暴露给模型的历史工具。
- [SQLite search backend](../../session-query/session-query-sqlite/README.zh.md) — 持久的派生索引。
- [Generated composition graph](../../../apps/cli/composition.md) — 每个随附 profile 的确切行。

-----

<a id="model-experience"></a>
## 模型体验

### Beardy 系统提示词

#### 模型看到什么

该 profile 在基础提示词各节与所选工具之前贡献一段稳定的 persona。运行时按当前进程解析 `{{model}}` 与 `{{cwd}}`。`beardy-unattended` 与 `beardy-discord` 预设追加稳定指令：无人值守运行自行决策并遵循任务的投递指令，缺少指令时使用 `discord_send`；Discord 回复先给结果，使用简洁段落、粗体标签、项目符号、链接与完整围栏代码，并避免在回复中披露私有推理和内部工具跟踪。

##### Persona 文本

```markdown
You are Beardy, a warmly pragmatic coding and research agent powered by the {{model}} model. Your working directory is {{cwd}}.
When the user refers to a past conversation, use session_search before asking them to repeat it.
```

#### Token 影响

一段短小稳定的 persona，加上随数据变化的基础提示词各节与所选工具 schema。

#### KV Cache 影响

对固定的 profile、provider、模型与工具清单保持稳定。persona 只在 profile 组装或模型上下文变化时改变。

### Harness 创作

#### 模型看到什么

Beardy 还会收到 Creator mode 的 Cordis 检查与临时 package 工具，以及 `editing-cordis-compositions` skill。shell 与文件系统工具仍是修改持久源码或用户 preset 的路径；动态 Cordis package 在停止或 DSH 重启后消失。`beardy-unattended` preset 会禁用这两个创作面。

#### Token 影响

creator 工具向模型上下文添加稳定的 schema 与指引。运行时 package 代码及其注册只在对应 package 运行期间添加随数据变化的内容。

#### KV Cache 影响

对固定 profile，creator 工具的 schema 与指引保持前缀稳定。启动或停止某个动态 package 会在其贡献工具或提示词节时改变后续请求的前缀。

### SOUL.md 个性

#### 模型看到什么

Beardy 把 `$DSH_HOME/SOUL.md` 作为持久的全局指令，与 `$DSH_HOME/AGENTS.md` 一同加载。该文件包含语气、主动性、不确定性、分歧、连续性与简洁偏好；它不授予权限，也不取代项目指令。

#### Token 影响

该文件占用正常的 workspace-instruction 预算，并与其他指令文件一样留在持久会话历史中。

#### KV Cache 影响

对某工作区而言，该文件在内容变化前保持稳定；编辑它会改变后续请求的指令前缀。

### 策展记忆与时钟

#### 模型看到什么

`memory` 工具 schema，含两个固定目标（`user`、`memory`）与三个动作，外加在首次请求前作为 user-global 指令捕获的 `$DSH_HOME/USER.md` 与 `MEMORY.md` 内容。捕获的内容（包括文件缺失状态）在恢复与压缩后仍保留；写入只影响新会话。时钟贡献一段稳定的时间上下文小节，每个会话最多每小时重新渲染一次。

#### Token 影响

一个小而稳定的工具 schema，加上指令预算内随数据变化的记忆文件；时钟增加一短节带日期的内容，只在刷新时改变。

#### KV Cache 影响

记忆文件内容在当前会话的持久指令前缀中保持固定。新会话会捕获最新文件。每小时的时钟刷新只改变一个靠后的小节，而非整个前缀。

### 会话历史工具、Web 搜索与 Web 抓取

#### 模型看到什么

该 profile 添加来自 [`dsh-tool-session-query`](../../session-query/tool-session-query/README.zh.md) 的五个只读历史工具 schema 与指引，包含生成的 [`session_search`、`session_event_search`、`session_trace`、`session_event_trace` 与 `session_event_read` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-session-query)。既有 Web 工具经配置的 SearXNG 端点搜索、经匿名 HTTP provider 抓取；确切的 schema 与结果文本由其归属包提供。

#### Token 影响

组合包挂载期间存在五个稳定的历史工具 schema 与一节简洁指引。搜索、追踪、事件与抓取结果是已记录对话中随数据变化的追加内容。

#### KV Cache 影响

对固定的组合包与配置，历史指引与工具 schema 保持前缀稳定。搜索与抓取结果追加在该可复用前缀之后。


## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **技能学习需要审阅** — Beardy 可以创建和更新用户技能，并在持续使用工具后收到留存提醒。它没有自动质量评估或合并流程。
- **运行时调度需要配置** — 操作者配置预设和工作区允许清单后，`cron_manage` 与 `/cron` 可管理存储任务。配置任务除笔记和显式运行外保持只读。
- **每个 bot token 只能一个进程** — 网关会回复它看到的每一条入站私信，因此若另一个挂载 `dsh-discord-gateway` 且使用同一 token 的 profile 并行运行，会重复回复。
- **没有通用消息网关** — 该 profile 提供 Web 应用；Discord 是它唯一的渠道适配器，没有 Telegram、Slack 或类似服务的适配器。
- **无人值守记忆写入需要回答器** — `beardy-unattended` 与 `beardy-discord` 要求审批。Discord 支持按钮、表情回应或文本回复审批；没有回答器的无人值守会话拒绝写入。
- **搜索使用独立数据库** — 不要把 `session-query-sqlite.path` 指向 session-persistence 数据库。
- **SearXNG 是外部前置条件** — 默认本地端点必须正在运行并暴露 JSON 响应格式，Beardy 才能使用 `web_search`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>
