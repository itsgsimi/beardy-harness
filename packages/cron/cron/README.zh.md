---
description: "本机（Host）上无人值守的定时 agent 运行：来自配置与运行时创建的 cron 任务各自开启一个会话，用选定的预设组合执行其提示词，在多次触发之间携带连续性笔记，并把完成的运行广播出去供渠道投递，供希望 agent 按时间表行动的操作者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-cron

[English](README.md) | 中文

## 概述

本包让 agent 按 cron 计划运行。配置提供只读任务；操作者也可以通过 `cron_manage` 和 `/cron` 管理持久任务，但受预设、工作区、数量、间隔和审批限制。开始执行的触发会开启带有连续性笔记的 Session。每次触发都会记录结果；前一次工作待完成，或选定的本地模型路由被主动卸载时，会记录 `skipped`。Discord 投递会重试，不重复模型工作。关闭会中断运行；重启会记录被遗弃的预留，且只在下一个匹配时恢复。

活动运行仅在运行期间向 Discord 审批应答者提供 `deliverChannel`。没有频道的运行无法获得 home 写入审批。

## 目录

- [模型选择](#model-selection)
- [命令](#commands)
- [投递目标](#delivery-targets)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="model-selection"></a>
## 模型选择

cron 行上的 `modelSelection: { provider, model, reasoningEffort? }` 为每次触发选择确切路由，包括持久任务；已配置任务可以用自己的 `modelSelection` 覆盖它。两处都未设置时，运行继承完整的当前 `agentDefaultModel` 选择。每次触发在打开 Session 前依据已注册的适配器检查显式选择；未知路由或不支持的推理力度会使该次运行失败并指明任务名。有效选择记录在 Session 的 `request/header` 中。

-----

<a id="commands"></a>
## 命令

`/cron status [name]` 在 Discord 和 Web 命令输入中运行，无需模型轮次。它显示最近保留的结果、结果 id、已记录的运行时长、失败或跳过的代码与原因，以及下一次已启用的触发时间。跳过的触发没有 Session。缺少时长的旧历史显示 `unknown`。失败运行通过现有 Discord 结果通知携带任务名、Session id、失败代码和下一次触发时间；启用结果通知时，跳过的触发也走同一通知路径。

-----

<a id="delivery-targets"></a>
## 投递目标

`deliverChannel` 与工具字段 `deliver_channel` 接受 Discord 频道 id、`discord:<id>`、`signal:group:<base64 id>` 或 `signal:number:<E.164>`，其他值在加载时或在工具中于审批前被拒绝；此项校验之前保存的任务保留原目标。目标传输方式的所属方认领 `cron/run-finished`，并发布 `cronDeliveryContent` 选出的文本。只有 Discord 目标会收到审批提示，因此投递到 Signal 的运行无法获得 home 写入审批。

-----

<a id="model-experience"></a>
## 模型体验

### 触发提示词

#### 模型看到什么

一次运行的首个请求把任务的 `prompt`、固定的连续性指令以及此前运行的当前笔记放入一条用户角色消息，并注明任务名与触发时间。首次运行会被要求在结束前记下下一次运行应当知道的事情。任务指定投递渠道时，提示词会告知模型最终回答将被自动投递，并要求它不要再通过 `discord_send` 单独发送相同内容。

#### Token 影响

每次触发对应一条用户消息——提示词、连续性指令与笔记——加上该运行自身工具调用产生的消息。每次运行都是独立会话，因此成本按触发重复，而不是累积进一段很长的对话；任务可选的 `turnTimeoutMs` 限制其运行时长，未设置时使用插件的 `turnTimeoutMs`。

#### KV Cache 影响

每次触发都启动一个新会话，其预设组合构成它自己的初始前缀，因此各次运行之间不共享缓存历史。笔记变化时会改变该前缀；在同一次运行内部，追加的轮次照常可复用。

### `cron_manage` 工具

#### 模型看到什么

一个带 `action` 枚举的工具：`list`、`create`、`update`、`delete`、`pause`、`resume`、`run_now` 与 `note`。create 必须提供名称、计划、时区、提示词、预设组合与工作区；标题、任务专属超时和投递渠道可选。update 必须提供名称及至少一个修改字段；delete、pause、resume、run_now 必须提供名称；note 必须提供名称和替换笔记，工具描述告诉模型任务可在自身运行期间替换自己的笔记。结果是简短的确认行；`list` 额外为每个任务给出一行，标明其来源（`config` 或 `stored`）与armed 状态。

#### Token 影响

只要某个会话挂载了该工具，其 schema 就位于该会话的每一次请求里；每次调用追加一个小结果。缺少字段的错误会列出该操作所需字段。超过配置的 `notesMaxChars` 上限的笔记会被拒绝，并要求压缩内容；其他护栏拒绝会点明被违反的界限。

#### KV Cache 影响

注册按组合静态完成，schema 不会在会话中途变动。结果照常追加。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **放开之前创建保持锁定** —— `allowedAgentPresets`、`allowedPermissionPresets` 与 `allowedWorkspaceRoots` 默认为空，因此存储任务的创建会被拒绝，直到操作者在配置中列入允许的预设与根目录。创建和更新时通过 `realpath` 比较工作区与根目录；每次触发都会重新检查存储任务的工作区，若越出根目录就记录失败结果。
- **受审批的写入需要审批服务** —— `requireApproval` 开启（默认）且没有挂载审批服务时，create、update、delete、resume、run_now 与 note 会直接拒绝，而不是未经批准落地。审批请求显示拟创建的任务或字段变化，工具只应用获批的值。为了在无人审批时保持连续性，有一个例外：活动运行自己的 Session 可以替换该任务的笔记，仍受 `notesMaxChars` 约束，宿主会以 info 级别记录。对其他任务的笔记以及其他所有操作仍需审批。
- **投递需要接受交接的监听器** —— `cron/run-finished` 使用有时限的串行交接。面向渠道的结果会保持待投递，直到监听器持久接受。如果前一次运行的输出未能在任务的超时期限内投递，下一次触发会记录 `skipped` 和 `PREVIOUS_OUTCOME_PENDING`。跳过通知会继续重试，但不会阻止后续运行开始。
- **停机期间错过的触发不补跑** —— 进程停止期间本应触发的计划会在恢复后被跳过；下一个计划时间照常运行。
- **每个任务只重叠一次触发** —— 仍在运行的任务会让下一次触发记录为 `skipped` 和 `PREVIOUS_RUN_IN_PROGRESS`，而不是排队。历史记录及可选的 Discord 通知会保留原因。其他任务的 Session 清理不会占用此任务的重叠保护。
- **会话会累积** —— 已完成的运行超过 `maxLiveRuns` 时按最旧优先释放；活动运行会保持挂载直到收尾。如果句柄的释放始终不结束，超过释放期限后仍可能占用资源；cron 会记录未完成的清理并继续运行。持久 Session 日志继续保留在磁盘上。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

`schedule.ts` 把 croner 包在 `Scheduler` 接缝（seam）之后（`cronerScheduler`、只校验表达式而不调度的 `assertSchedule`，以及为调用方的重启补跑找出某一时刻或之前最近一次匹配的 `latestMatchAt`），因此测试可以用假调度器挂载任务，同时用真实调度器证明一秒周期的表达式确实触发。`domain.ts` 定义 `cron_jobs` 存储域：`jobs` 表存放存储的任务定义，`state` 表为两种来源保存笔记与运行历史。`registry.ts` 把配置任务与存储任务合并成一个视图，在每次变更上执行护栏，并在构造时拒绝被两种来源同时占用的名字。`launch.ts` 负责会话创建顺序——解析 agent 预设、解析权限预设、注册工作区、生成会话 id、`agents.create`、attach、应用权限、命名——任一后续步骤失败时回滚为 detach 加 dispose。`index.ts` 承载活动定时器（`createSchedulerHost`：sync、trigger、重叠守卫），并在写入落到 `jobs` 表时重新排程；`tool.ts` 与 `command.ts` 是注册表之上面向模型与面向人的界面，审批服务在调用时刻读取。

</details>

**运行时不变量：**不发布伴生包。持久任务记录在加载时经 zod 校验，且每次变更先落到存储域才对外可见，因此没有独立观察能与它们背离。`tests/loader-composition.spec.ts` 会真正启动 Loader，证明不可用的配置拒绝加载、存储的任务在重启后被正常调度。
