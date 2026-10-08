---
description: "Beardy agent profile 组合包：带策展记忆、持久会话搜索、SearXNG 搜索、研究抓取与按 token 门控的 Discord 投递能力的持久化、历史感知 Web agent。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-beardy

[English](README.md) | 中文

Beardy 保留 Odysseus 研究桥接作为当前的显式启用方案。原生 `deep_research` 可通过[一组配置档补丁](#select-native-deep-research)切换；两个工具不能同时挂载。

## 概述

Beardy 组合包在 `dsh-base` 与 `dsh-web-app` 之上添加持久化、具备历史感知能力的 agent profile。它声明的 `beardy`、`beardy-unattended` 和 `beardy-discord` preset 包含身份、跨会话策展记忆、会话搜索、对话时钟、Web 搜索和抓取，以及受 wttr.in 三天预报限制的天气工具。可选的定时运行与 Discord 投递需要 `DISCORD_BOT_TOKEN`；组合包不附带 cron 任务。在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 中配置简报、目的地、工作区和权限。已启用但缺少配置的条目会在 schema 校验时失败。

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

组合包以 `probes: []` 挂载 `dsh-health`，因此部署 patch 提供具名 URL 和通知频道之前，不会宣称任何端点可用。组合包不内置端点或凭据。`local-model-control` 条目默认禁用，个人补丁提供固定后端、授权预设、分组及持久状态文件后才能启用。命令行为见[本地模型控制](../../health/local-model-control/README.zh.md)。`brief-collector` 条目保持禁用：由 cron 任务指定的个人 Agent 预设挂载该包，详见[简报收集器](../../cron/brief-collector/README.zh.md)。

### 运行随附的 Beardy profile

创建选择 base、Web 与 Beardy 组合包层的 `$DSH_HOME/profiles/beardy/package.json`，然后运行该 profile：

```json
{
  "name": "dsh-profile-beardy",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@deepseek-ai/dsh-beardy"] } }
}
```

```sh
dsh --profile beardy --dump-default-config
dsh --profile beardy
```

该 profile 使用 patch 实时热重载，把专用的派生搜索索引存放在 `$DSH_HOME/session-search.sqlite`，并在首次搜索时打开 SQLite。profile 自身与 home 层的 patch 文件可以按普通的 profile 层规则替换这些行。

<a id="select-native-deep-research"></a>
### 选择原生深度研究

Beardy 随附的 `tool-odysseus-research` 桥接条目，以及原生 `research-local` 和 `tool-research` 条目默认均被禁用。现有个人配置档可以继续启用已配置的桥接。若要选择原生引擎，请把以下三个替换条目放入 `$DSH_HOME/profiles/beardy/cordis.patch.yml`；若其中已有桥接条目，请替换它：

```yaml
- id: tool-odysseus-research
  disabled: true

- id: research-local
  disabled: false
  config:
    provider: deepseek-official
    model: deepseek-flash
    ownerScope: profile
    ownerNamespace: beardy

- id: tool-research
  disabled: false
```

提供方和模型必须对应已准入的 LLM 路由。该配置档命名空间允许此单用户 Beardy 配置档中的每个 Session 访问其运行；若报告仅应属于一个调用方 Session，可改用 `ownerScope: session`。[原生工具](../../research/tool-research/README.zh.md)提供 `deep_research` 和分页报告。若继续使用 Odysseus，请按照[远端必需配置](../../web/tool-odysseus-research/README.zh.md)启用桥接条目。同时挂载两个工具会在加载时失败。默认启用的 `ui-research` 条目为两种工具提供[报告对话框和研究设置标签页](../../research/client-ui-research/README.zh.md)。

Beardy 还随附默认禁用的 `fantasy-yahoo` 和 `tool-fantasy` 条目。个人补丁先提供私有 DSH token 路径、一次性导入来源、调用方到球队的映射及人工授权预设，再同时启用两项。[Fantasy 提供方](../../fantasy/fantasy-yahoo/README.zh.md)负责授权与刷新；[工具](../../fantasy/tool-fantasy/README.zh.md)返回有界只读结果。默认禁用的 `fantasy-weekly-reports` 条目发送[定时每周报告](../../fantasy/fantasy-reports/README.zh.md)；个人补丁提供其球队、频道、时间表和工作区，并在启用 Yahoo 条目、以默认配置提供[球员预测](../../fantasy/fantasy-projections-sleeper/README.zh.md)的默认禁用 `fantasy-projections-sleeper` 条目和 profile 范围的原生研究后一同启用它。

`tool-homelab` 条目默认禁用，个人补丁须提供 Beardy 可执行文件、其密钥文件、Docker 主机允许列表以及可调用它的 agent 预设。[homelab 工具](../../homelab/tool-homelab/README.zh.md)运行固定的只读 Beardy 命令；为他人服务的预设不要列入 `allowedAgentPresets`。

`camera-ring` 和 `camera-watch` 条目默认禁用，个人补丁须提供 Ring 刷新令牌的凭据引用、要监视的设备、ffmpeg 路径、时区、通知策略和 Discord 频道。[Ring 提供方](../../camera/camera-ring/README.zh.md)在每次门铃按下或移动警报时截取几帧画面；[摄像头监视](../../camera/camera-watch/README.zh.md)在一次记录在案的模型轮次中对画面分类，经网关发件箱发送通知，并用事件历史回答 `camera` 工具。完成一次性 Ring 登录后同时启用这两项。

`signal-cli` 和 `signal-notices` 条目默认禁用，个人补丁须提供以 `-a <number>` 启动的 signal-cli 守护进程的回环 `baseUrl`，并把生产方指向 Signal 目标，例如 `camera-watch` 上的 `deliverChannelId: 'signal:group:<base64 id>'`。[signal-cli 提供方](../../signal/signal-cli/README.zh.md)经持久发件箱发送；[通知使用方](../../signal/signal-notices/README.zh.md)认领目标为 Signal 的摄像头、健康和定时运行通知，Discord 目标仍由网关处理。同时启用这两项。

Beardy 默认把 `web_search` 发往 `http://127.0.0.1:8080` 的 SearXNG JSON 端点。启动前设置 `SEARXNG_BASE_URL` 可改用其他实例，并在该实例的 `search.formats` 配置中启用 `json` 格式。端点契约见 [SearXNG provider README](../../web/web-search-searxng/README.zh.md) 与 [SearXNG Search API](https://docs.searxng.org/dev/search_api.html)。

### 部署为常驻的 Discord agent

组合包只在进程环境中存在 `DISCORD_BOT_TOKEN` 时才挂载具备 Discord 能力的三行，并且刻意不携带任何目的地或权限值。部署方用一个环境文件和一个 profile patch 层提供这些值。

把非机密的引用与标识符放进一个环境文件（权限 `0600`，绝不入库）：

```sh
DISCORD_BOT_TOKEN=...
DISCORD_CHANNEL_ID=<channel snowflake that discord_send targets>
DISCORD_DM_USER_IDS=<user ids allowed as direct-message targets>
DISCORD_ALLOWED_USER_IDS=<user ids whose inbound messages the gateway answers>
BEARDY_LANE_PROVIDER=<registered provider route whose model supports medium>
BEARDY_LANE_MODEL=<exact model id with medium effort>
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
    modelSelection:
      provider: !!js process.env.BEARDY_LANE_PROVIDER
      model: !!js process.env.BEARDY_LANE_MODEL
      reasoningEffort: medium

- id: cron
  config:
    modelSelection:
      provider: !!js process.env.BEARDY_LANE_PROVIDER
      model: !!js process.env.BEARDY_LANE_MODEL
      reasoningEffort: medium
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

设置这些环境变量前，先从已注册的模型目录选择确切的提供方和模型。网关在对话开启时检查显式路由和推理力度；cron 在每次触发打开 Session 前检查。不支持的选择会使该对话或运行失败，并给出明确错误；官方 DeepSeek 路由不接受 `medium`。已配置的 cron 任务可设置自己的 `modelSelection`；持久化任务继承 cron 顶层选择。省略任一行的 `modelSelection` 时，会继承完整的当前默认选择，包括推理力度。已有 Discord Session 恢复时沿用日志中的选择，Web 保留自己的模型选择器。

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
- 对话时钟（`dsh-time-context`）为跨越数天的对话解析相对时间，持久注入按小时节流并注明本地星期几。
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

patch 选择随发行版交付的 `beardy` agent preset，覆盖 `session-query-sqlite`，选择 `searxng` web provider，禁用 DeepSeek 搜索行，启用 `tool-web`，并插入 `tool-session-query`、`tool-weather`、`time-context` 以及按 token 门控的 `tool-discord`、`discord-gateway` 与 `cron` 行。它还插入默认禁用的 `speech-whisper` 转写行（由 profile 层按 id 启用）和 `ui-voice` 浏览器听写行。三个 profile YAML 声明通过 `agent-preset-registry` 注册 `beardy`、`beardy-unattended` 和 `beardy-discord`；每个声明都包含 persona、作为全局指令候选的策展记忆文件、`memory` 工具以及按 preset 作用域挂载的 `tool-schedule` 提醒工具。无人值守与 Discord 声明增加各自的回复指引，并要求记忆写入经过审批。SearXNG 负责 Web 搜索传输与结果映射，搜索后端持有独立的派生 SQLite 数据库，历史工具 Consumer 负责面向模型的 schema、指引与工作区授权。组合包自身不持有任何运行时服务或可变状态。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Beardy 在 base 与 Web 组合包之上的 patch 层 |
| [`src/index.ts`](src/index.ts) | 包入口；不携带运行时 API |
| [`tests/beardy.spec.ts`](tests/beardy.spec.ts) | manifest、patch、依赖与默认值检查 |
| [`tests/composition.spec.ts`](tests/composition.spec.ts) | token 门控、零部署数据与必填字段失败检查 |

### Invariant 归属

不发布运行时 invariant companion，因为该组合包只替换和插入由其他包拥有的行。每个运行时包各自检查自己的服务、事件与持久化关系。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Bundle package map](../README.zh.md) — DSH 随附的各 profile 层。
- [app-boot profile contract](../../boot/app-boot/README.zh.md) — profile 初始化与 patch 优先级。
- [Memory tool package](../../memory/tool-memory/README.zh.md) — 有界的核心事实和按需读取的主题文件；Beardy 预设要求 home 写入经过审批。
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

- **技能学习需要审阅** — Beardy 可以检查、创建和更新用户技能。一个已完成轮次若有至少 20 次工具调用且没有加载技能，每个 Session 最多会收到一次提醒。检查会对薄弱的调用指引和目录重叠发出警告，但 Beardy 不会自主合并技能。
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
