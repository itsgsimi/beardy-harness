---
description: "定时生成每周 Yahoo Fantasy 报告：实时联盟数据、每份报告一次经审阅的研究运行，并投递到 Discord。"
kind: "package-reference"
---

# @deepseek-ai/dsh-fantasy-reports

[English](README.md) | 中文

## 概述

为每支配置的 Yahoo 球队发送每周完整报告以及周四和周日更新。每份报告从 `ctx.fantasy` 读取实时阵容、联盟阵容位、计分、对阵、伤病状态和预测分数，在网络上逐一研究每名在册球员，并在一次持久研究运行中由模型撰写和审阅。只有通过代码检查和审阅策略的报告才会送到 Discord；否则球队频道会收到失败通知。

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

装载 Fantasy 提供方（如 [fantasy-yahoo](../fantasy-yahoo/README.zh.md)）、`ownerScope: profile` 的[本地研究提供方](../../research/research-local/README.zh.md)、`ctx.web` 搜索与抓取提供方，以及所用目标的 `cron/run-finished` 投递监听器：Discord 频道 id 用 Discord 网关，`signal:group:<base64 id>` 与 `signal:number:<E.164>` 目标用 signal-notices。研究所有权不是 profile 范围时，插件会让本次触发失败并发送通知，因为报告历史必须比每次运行存续更久。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-fantasy-reports'
  config:
    timezone: America/Phoenix
    workspacePath: /home/user/.dsh/fantasy-reports
    teams:
      - id: googies
        name: The Googies
        teamKey: 470.l.809970.t.7
        channelId: '1472404859679670455'
        schedule: { full: '0 14 * * 3', thursday: '0 11 * * 4', sunday: '30 5 * * 0' }
```

`teams` 没有默认值。每支球队的联盟取自其球队键。研究、审阅与投递上限都有经过验证的默认值；[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-fantasy-reports)列出所有字段。

### 时间表与比赛周

每支球队在 `timezone` 中有三个 cron 表达式。触发逐个执行，每次研究运行至少在上一次开始后 `minimumStartGapMs`（默认 90 分钟）才开始。触发会解析包含其本地日期的 Yahoo 比赛周；超出 `firstWeek` 到 `lastWeek` 的范围时不做任何事。已有运行的比赛周与模式会被跳过，因此重复触发不会发送第二份报告。

### 重启补跑

插件启动时，会对每支球队在该时刻或之前的最近一个时段复查一次，前提是距该时段不足 `catchUpWindowMs`（默认 12 小时）；设为 `0` 即关闭补跑。周日时段使用更短的 `sundayCatchUpWindowMs`（默认 2 小时），从该球队的周日时段起算，使补跑的周日报告仍在开球前送达；启动间隔等待结束后会再次检查该窗口。其余由研究历史决定：没有运行或只有被中断运行的时段获得一次补跑；已完成的报告会以其原始触发时间再次交给投递，由监听器去重，因此先前交接失败的报告仍能到达 Discord；已有失败、被扣留、已取消或补跑过的运行的时段不做处理。本周更早的时段被最近的时段取代，永不补跑。

### 投递、通知与影子模式

完成的报告以 `answered` 结果和球队的 `channelId` 交给 `cron/run-finished`，由该目标投递方的持久发件箱发布。被扣留的报告发送代码 `FANTASY_REPORT_WITHHELD`；Yahoo、研究或模型失败发送 `FANTASY_REPORT_FAILED`。两种通知都不认可任何建议。设置 `shadowChannelId` 后，所有报告和通知都只发到该频道；报告以标明球队的影子标签开头，任务名以 `shadow-` 开头。

### 历史

每次运行都从球队的调用方 Session `fantasy-reports-<id>` 链接，其查询带有 `[fantasy-report:<team>:<season>:<week>:<mode>:<trigger>:<firedAt>]` 标签，其中 trigger 为 `scheduled` 或 `catch-up`，`firedAt` 是投递所携带的触发时间（epoch 毫秒）。新报告会向撰写阶段展示最多 `historyReports` 份同一球队、同一赛季的已完成报告，作为对比数据。Beardy 可以通过 `deep_research` 的 `list` 和 `report` 读取同样的报告。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

插件把每份报告作为[研究工作流](../../research/research/README.zh.md)启动：提供方记录工作流名称和提示词版本，每次模型调用都是该运行下一个有日志、无工具的阶段 Session。

1. **Yahoo 事实。** 工作流读取该周的阵容、每名球员的阵容位锁定和对阵，并把联盟、球队和比赛周与请求核对。在册球员获得短 ID（`P1`、`P2`……）。
2. **来源。** 每名球员最多有 `searchesPerPlayer` 次查询，并保留最多 `pagesPerPlayer` 个不在 `excludedHosts` 中的 HTTPS 页面。页面只有写出该球员姓名时才被采纳；姓名过短无法可靠匹配时直接采纳页面。任何模型读取页面之前，都会移除 FantasyPros 排名与预测标题，并把“30th easiest opponent”这类赛程强度序数改写为直白的难度描述。页面以名单姓名附近的原文段落限定长度。每次搜索、抓取失败和采纳决定都进入运行，每个被采纳页面的模型可见原文成为来源附件。
3. **草稿。** 撰写阶段返回 JSON：每名球员一行并附 1–2 条带引文的事实，外加阵容、行动、关键抉择和注意事项。
4. **代码检查。** 引文必须是所引页面中 12–300 个字符的原文摘录，且该页面写出了此球员。阵容必须用合格球员填满联盟的首发位，不得包含轮空或被 Yahoo 标为缺阵、伤病名单、禁赛或非现役的球员；每名首发都必须是 `START` 或 `CONDITIONAL`。因比赛已开始而被 Yahoo 锁定阵容位的球员保持 Yahoo 显示的位置：被锁定的首发保留其阵容位并免于可出场检查，被锁定的替补不得首发。失败会交给结构修复补丁处理，最多 `maxStructuralRepairs` 次，且不消耗事实审阅次数。
5. **审阅。** 审阅阶段返回的发现必须逐字引用草稿，若指出矛盾还须逐字引用来源或 Yahoo 上下文。无锚定、仅措辞、无需修改和重复的发现会被丢弃并保留在证据中。每次有发现的审阅之后都跟一次修复补丁。完成 `maxReviews` 次审阅后，若仍有错误球队、赛程或赛季的发现，报告被扣留；其他发现会再修复一次，报告会注明这些修改未经再次审阅。
6. **报告。** 由代码渲染已接受的草稿：行动、相对当前 Yahoo 阵容的变更、阵容及被 Yahoo 锁定的球员、关键抉择、每名球员的 Yahoo 阵容位及锁定、状态、轮空周和预测分数、后续检查，以及不附带预览的来源链接。已接受的建议不会再被模型改写。证据文件保存 Yahoo 快照、来源、草稿和每次审阅。

不发布不变量组件：定时器、队列顺序和投递尝试只能通过本插件自己的日志行观察，所有持久关系都由研究提供方负责。

| 源文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 定时器、重启补跑、比赛周解析、历史、通知与投递 |
| [`src/workflow.ts`](src/workflow.ts) | 来源、阶段与发布策略 |
| [`src/draft.ts`](src/draft.ts) | 草稿解析、代码检查、补丁与审阅筛选 |
| [`src/lineup.ts`](src/lineup.ts) | Yahoo 阵容位合法性、阵容位锁定与阵容变更 |
| [`src/sources.ts`](src/sources.ts) | 姓名采纳、页面清理与段落 |
| [`src/render.ts`](src/render.ts) | 报告 Markdown |
| [`src/prompts.ts`](src/prompts.ts) | 带版本的阶段指令 |
| [`src/config.ts`](src/config.ts) | 配置验证 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Fantasy 子系统](../../../docs/subsystems/fantasy.zh.md) — Yahoo 读取与每周报告路径。
- [研究子系统](../../../docs/subsystems/research.zh.md) — 持久运行与使用方工作流。
- [每周报告决策](../../../.agents/notes/implemented/feature/2026-09-27-native-fantasy-weekly-reports.zh.md) — 为何报告采用研究工作流，以及保留了哪些 Odysseus 防护。
- [锁定与补跑决策](../../../.agents/notes/implemented/feature/2026-09-27-fantasy-report-locks-and-catch-up.zh.md) — 为何由代码检查被锁定的阵容位，以及重启如何补跑错过的时段而不重复发送。

-----

<a id="model-experience"></a>
## 模型体验

### 每周报告阶段

#### 模型看到的内容

每个阶段都是报告研究运行下一个新的无工具 Session，在阶段系统提示词和运行时上下文之后只有一条任务消息。撰写消息包含带版本的指令、JSON 形式的 Yahoo 上下文（球队、比赛周、报告时间、首发与替补阵容位、计分值、对阵预测，以及每名球员的 ID、NFL 球队、位置、Yahoo 阵容位及其是否锁定、状态、伤病说明、轮空周和预测分数）、标为对比数据的早先报告，以及标为不可信数据的已采纳页面段落。审阅消息包含 Yahoo 上下文、被引用的段落和草稿。修复消息包含错误或发现、受影响的行、其余各部分以及受影响的段落。

#### Token 影响

撰写消息最多携带 `promptSourceChars` 个字符的段落（默认 120,000）以及阵容上下文；审阅和修复只发送被引用或受影响的段落。输出分别受 `writerMaxTokens`、`reviewerMaxTokens` 和 `repairMaxTokens` 限制。

#### KV Cache 影响

每个阶段都是新的单轮 Session，阶段之间不复用前缀。同一球队、同一比赛周的报告共享指令前缀，但从 Yahoo 上下文起开始不同。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 对手和开球时间只来自被引用的页面；报告没有经过代码核对的赛程来源，因为 Yahoo 的阵容与球员读取只提供轮空周和阵容位锁定，没有 NFL 对手或开球时间。
- 阵容位锁定在报告运行时读取，比赛稍后才开始的球员此时尚未锁定；报告仍提示在修改 Yahoo 前检查阵容锁定，且从不执行修改。
- 补跑只在插件启动时进行，且只针对每支球队的最近时段。补跑期间再次被中断的时段、窗口关闭后投递仍失败的已完成报告，以及标签中没有触发时间的已完成报告，都只保留在研究历史中。
- 只有提供方为在册球员返回预测分数时，报告才显示 Yahoo 预测。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

快照场景 `snapshots/session/fantasy-report` 基于匿名化的 Yahoo 抓取回放一次影子模式报告，其中包含一个有锚定的发现及其修复；投递出的 Discord 文本是其工作区预期结果。

</details>
