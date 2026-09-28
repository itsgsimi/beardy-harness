---
description: "摄像头监视：每个摄像头事件一次记录在案的视觉模型分类、通知策略、附带画面的 Discord 通知、事件历史和 camera 工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-camera-watch

[English](README.md) | 中文

## 概述

只在重要的摄像头事件发生时收到提醒，其余时间保持安静。对来自 `ctx.camera` 的每次门铃按下或移动警报，监视插件在一次记录在案的轮次中把画面交给视觉模型，读取结构化判定，再应用策略：每次门铃按下、包裹送达、夜间出现的人、指定摄像头上驶入或驶离的车辆，以及在画面中停留的人。通知附带一帧画面发送到 Discord 频道；门铃按下会凭第一帧立即通知，分类后再补充描述。有界的事件历史供只读的 `camera` 模型工具作答。

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

需要装载 [camera-ring](../camera-ring/README.zh.md) 等摄像头提供方、支持图像输入的模型路由、附件存储、存储域后端；如需通知，还需目标的投递方：Discord 频道由 [Discord 网关](../../discord/discord-gateway/README.zh.md)投递，Signal 目标由 [signal-notices](../../signal/signal-notices/README.zh.md)投递。`timezone` 为必填；设置 `deliverChannelId` 才会发送通知。

| 配置 | 含义 |
|---|---|
| `timezone` | 夜间时段、通知时间和工具结果所用的 IANA 时区 |
| `modelSelection` | 精确的 `{ provider, model, reasoningEffort? }`；未设置时每个事件使用主机默认模型 |
| `deliverChannelId` | 通知目标：Discord 频道 id、`discord:<id>`、`signal:group:<base64 id>` 或 `signal:number:<E.164>`；未设置时只保留历史 |
| `workspacePath` | 记录在分类 Session 上的绝对工作目录 |
| `policy.ding`、`policy.packageDelivered`、`policy.nightPerson` | 通知门铃按下、包裹送达和夜间出现的人（默认全部开启） |
| `policy.nightStart`、`policy.nightEnd` | 以本地 `HH:MM` 表示的夜间时段，默认 `21:00` 到 `06:00` |
| `policy.personDevices` | 任何时段出现人物都会触发通知的设备 ID，例如前门；默认为空 |
| `policy.vehicleDevices` | 车辆活动会触发通知的设备 ID |
| `policy.vehicleActivities` | 在这些设备上触发通知的车辆活动：默认 `arriving` 和 `leaving`，可加入 `passing` 和 `parked` |
| `policy.lingerSeconds` | 出现人物的首尾画面之间达到多少秒算作逗留，默认 20 |
| `policy.minConfidence` | 门铃按下之外的通知所需的最低判定置信度，默认 0.5 |
| `immediateDingNotice` | 分类前先发送带第一帧的门铃通知，再以后续消息发送分类后的通知；默认开启 |
| `maxOutputTokens`、`turnTimeoutMs` | 分类输出上限和时限 |
| `maxConcurrent`、`maxQueued` | 同时进行的分类数，以及超出后排队等待的事件数 |
| `retentionDays`、`maxHistory`、`sweepIntervalMs` | 历史记录及其已存储画面的保留天数和条数上限，以及两次保留清理之间的间隔（一分钟到一天） |
| `deliveryAttempts`、`deliveryRetryMs` | 单条通知的交接尝试次数及间隔 |
| `failureNoticeThreshold`、`failureNoticeIntervalMs` | 连续多少次分类轮次失败后发送失败通知，默认 3（1 到 100），以及两条失败通知之间的最短间隔，默认六小时（一分钟到七天） |
| `tool`、`toolMaxEvents` | 是否注册 `camera` 工具，以及单次结果的上限 |

`policy.personDevices` 或 `policy.vehicleDevices` 中不对应任何提供方设备的条目以及空的 `policy.vehicleActivities` 列表都会导致加载失败。模型路由不在加载时检查，因为提供方在监视插件之后注册。路由的提供方注册后，监视插件会解析一次该路由（包括图像输入检查），并记录 `camera-watch: classifying with <provider>/<model>`，或以 `camera-watch: model route check failed:` 开头、附带原因链的错误；检查失败不会中止主机。每个事件仍会解析路由：无法解析的路由使事件以 `MODEL_UNAVAILABLE` 记录，声明不接受图像输入的路由使事件以 `MODEL_NOT_VISION` 记录；门铃按下仍会发送通知。

路由检查失败、事件以 `MODEL_UNAVAILABLE` 或 `MODEL_NOT_VISION` 记录，或者连续 `failureNoticeThreshold` 次分类轮次以 `TIMEOUT`、`TURN_FAILED`、`NO_ANSWER` 或 `SESSION_FAILED` 结束时，会向 `deliverChannelId` 发送一条失败通知，每个 `failureNoticeIntervalMs` 内最多一条：`⚠️ Camera classification is failing (<code>: <cause>). Motion alerts are paused; doorbell presses still post.` 路由失败时原因是最内层错误的第一行，轮次失败时原因是连续失败的次数；`policy.ding` 关闭时通知在 `Motion alerts are paused.` 处结束。失败通知之后第一次得到回答的分类会发送 `Camera classification recovered.`。未设置 `deliverChannelId` 时两者只写入日志，分别为 `camera-watch: classification is failing (<code>: <cause>)` 和 `camera-watch: classification recovered`。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

事件按 ID 排队；重复的 ID 或未知设备会被忽略。同时最多运行 `maxConcurrent` 个分类；已有 `maxQueued` 个事件在等待时新到的事件不经分类记录为 `QUEUE_FULL`。没有画面的事件跳过分类，记录为 `NO_FRAMES`。

每次分类都会打开一个不带 agent 预设的根 Session，只允许一次模型请求。其 Agent 作用域把分类提示词注册为人设前缀段中的完整系统提示词，因此主机人设和其他所有段都被排除；抑制运行时上下文；通过 `system-prompt/assemble` 监听器去掉所有工具模式，这也覆盖其他插件在创建后注册到该 Agent 自身作用域的工具，例如 schedule 工具；并通过作用域内的工具守卫拒绝所有工具执行。提示词作为该 Session 的系统消息进入日志，请求头不记录任何工具。它唯一的其他输入是一条来源类型为 `camera` 的 `user/message`：提示文本加上作为图像块的画面。已完成的助手文本按宽松规则读取：取文本中的第一个 JSON 对象，即使它位于代码围栏或说明文字中；标签接受常见同义词和复数；数量、活动、车辆活动和置信度分别校验；置信度接受百分比；`none` 之外的车辆活动会补上 `vehicle` 标签。所有字段有效时读取结果为 `parsed`，部分字段有效时为 `partial`，没有 JSON 对象时为 `unparsed` 并保留第一行文本。轮次失败记录为 `TIMEOUT`、`TURN_FAILED`、`NO_ANSWER`、`NOT_PERSISTED`、`SESSION_FAILED`、`MODEL_UNAVAILABLE` 或 `MODEL_NOT_VISION`。

策略在代码中执行。门铃按下总会产生 `ding`。其他原因都需要置信度不低于 `minConfidence` 的 `parsed` 或 `partial` 判定：`package` 需要包裹且活动为 `delivering`，`night-person` 需要夜间时段内出现人物，`person` 需要 `personDevices` 所列设备上在任何时段出现人物，`vehicle` 需要列出的设备以及列在 `vehicleActivities` 中的车辆活动，`lingering` 需要出现人物的画面按记录的偏移跨越至少 `lingerSeconds`。模型自己给出的 `lingering` 活动从不触发通知。停放的车辆默认从不触发通知，因此总拍到家中车辆的车道摄像头不会因车灯、飞虫或风而通知；`passing` 默认关闭，因为车道外驶过的车流不是到达；`unknown` 车辆活动（包括该字段出现之前存储的判定）从不触发通知。`person` 通知的标题为 `Person at <设备标签>`；同时适用 `night-person` 时，历史记录和 `camera` 工具保留两个原因，通知只显示 `Person at night`。

当 `immediateDingNotice` 和 `policy.ding` 开启且配置了频道时，新门铃按下的 `camera/preview` 会立即把 ID 为 `camera:<事件 ID>:ding`、文本为 `Someone rang the doorbell`、带第一帧的通知交给 `camera/notice`。同一事件分类后的通知会等这次交接结束后再发送，因此排在第二条。历史记录在分类通知投递之前写入。分类后的通知包含设备标签、本地时间、原因、描述或缺少描述的原因，以及数量和置信度；展示的画面是第一张出现人物的画面，否则是第一张画面，若已送达的即时通知已展示过该画面则不再附带。`camera/notice` 是串行事件，由目标传输方式的所属方认领：Discord 网关把 Discord 目标接入发件箱，发件箱上传经校验的已存储画面及文本；signal-notices 把 Signal 目标排入 Signal 发件箱。无监听器接收时监视插件会重试交接，把分类通知的投递结果记录为 `delivered`、`undelivered`、`no-channel` 或 `none`，并在尝试过即时通知时把其结果记录为 `earlyDelivery`（`delivered` 或 `undelivered`）。首次发布之后新增的历史字段都是可选的或带默认值，因此早期记录仍能解析：没有车辆活动的已存储判定读取为 `unknown`。保留清理在启动时运行，此后每次在上一次清理结束 `sweepIntervalMs` 后再次运行。它删除每条超过 `retentionDays` 或超出 `maxHistory` 的记录，并通过 `ctx.attachments.deleteImage` 删除既不被保留记录引用、也不被未完成事件引用的画面。记录的某张画面删除失败时，该记录会保留，由下一次清理重试；已经不存在的画面视为已删除。删除了内容的清理会以 info 级别记录事件数和画面数。画面被删除时仍在 Discord 发件箱中等待的通知只发送文本。

路由的提供方在启动时已注册则立即检查路由，此后在每次该提供方刚出现的 `llm/adapters-updated` 时检查：提供方是 `modelSelection` 的提供方，未设置时是当时主机默认模型的提供方。只有提供方离开注册表后再次出现，才会再次检查。失败状态只保存在进程内。任何得到回答的分类都会结束连续的轮次失败；`NOT_PERSISTED`、`NO_FRAMES`、`QUEUE_FULL` 和路由失败既不延续也不结束它。失败通知的 ID 为 `camera-watch:classification-failing:<窗口起点>`，窗口是包含该通知、按 Unix 纪元对齐的 `failureNoticeIntervalMs` 时段，恢复消息在其后追加 `:recovered`；Discord 发件箱会忽略已持有的 ID，因此在同一窗口内重启不会重复发送该通知。失败和恢复通知不带画面，沿用事件通知的交接重试，也不写入历史。历史是唯一的持久状态，所有写入都经过存储域，进程内的失败状态也没有可与之分歧的独立观测，因此不发布不变量组件。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Camera 子系统](../../../docs/subsystems/camera.zh.md) — 事件、判定和通知交接。
- [工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-camera-watch) — 生成的 `camera` 模式。
- [Discord 网关](../../discord/discord-gateway/README.zh.md) — 投递通知的发件箱。

-----

<a id="model-experience"></a>
## 模型体验

### 分类 Session

#### 模型看到的内容

每个事件使用一个独立的根 Session，其完整系统提示词是下方的固定文本，没有运行时上下文，也没有工具。它收到一条用户消息：下方的指令，然后是按截取顺序排列的事件画面图像。指令第一行说明警报（`doorbell press` 或 `motion alert`）、设备标签、本地日期时间，以及每帧画面以整秒计的偏移。

##### 系统提示词原文

```markdown
You classify still frames from a home security camera.
The user message states the alert and shows the frames. Reply with exactly the one JSON object it asks for and nothing else.
You have no tools. Describe people only by what is visible and never guess who anyone is.
```


##### 第一行之后的原文指令

```markdown
Reply with only one JSON object and no other text:
{"labels":[],"counts":{},"activity":"none","vehicleActivity":"none","confidence":0,"description":"","personFrames":[]}

- labels: each of "person", "vehicle", "package", "animal" visible in any frame.
- counts: the most of each label visible at once, for example {"person":1}.
- activity: one of "delivering", "lingering", "passing", "ringing", "none".
- vehicleActivity: "arriving" or "leaving" when a vehicle drives into or out of the driveway or a parking spot across the frames, "passing" when one drives by without stopping, "parked" when every vehicle stays still (lights or a running engine do not count as moving), "none" when no vehicle is visible.
- confidence: how sure you are, from 0 to 1.
- description: one sentence of at most 25 words about what is happening. Do not guess who anyone is.
- personFrames: zero-based indices of the frames that show a person.
```

#### Token 影响

每个事件发出一次请求：约 60 个系统提示词 token、约 280 个指令 token，以及每帧一张图像（默认三帧），输出受 `maxOutputTokens` 限制。

#### KV Cache 影响

每次分类都是新的 Session，因此除系统提示词外，事件之间不共享前缀。

### Camera 工具

#### 模型看到的内容

一个 `camera` 模式，带可选参数 `camera`、`hours`、`limit` 和 `notified_only`（[模式](../../../docs/tool-catalog.zh.md#deepseek-aidsh-camera-watch)）。结果是 JSON 文本，包含时区、时间窗口、匹配总数，以及按时间从新到旧排列的事件：ID、本地时间、摄像头标签、类型、描述、标签、数量、活动、车辆活动、置信度、分类状态、是否有任何通知已送达，以及原因。

#### Token 影响

一次结果最多列出 `limit` 个事件（默认 20，至多 `toolMaxEvents`）；描述最多 200 个字符。

#### KV Cache 影响

设备列表固定时模式保持稳定；每次结果都会追加到调用方的工具历史中。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **分类 Session 比历史保存得久** — 会话持久化没有删除操作，因此记录和画面被删除后，每个分类 Session 仍留在会话日志中，其中的图像随后读取为缺失。单个 Session 日志与其画面相比很小，但日志会随每个分类事件增长（[决策](../../../.agents/notes/implemented/feature/2026-09-27-camera-frame-retention.zh.md)）。
- **未记录的事件保留其画面** — 关机时从队列中丢弃的事件、与已记录事件 ID 重复的事件，以及指向未知设备的事件，从不会被记录，因此没有清理任务能找到它们的画面。
- **已通知的门铃按下可能未被记录** — 提供方在门铃预览和完整事件之间停止时，即时通知已发送，但不存在历史记录或后续通知。
- **监视插件拥有已记录的画面** — 清理删除过期记录的画面时不会询问其他 `camera/event` 监听器，因此在 `retentionDays` 之后仍保留画面引用的其他消费方会发现画面缺失。
- **不识别身份** — 判定只泛指人物；识别熟人需要另外的、需主动开启的人脸库。
- **历史只读文本** — `camera` 工具返回描述，不返回已存储的画面。
- **关机时的写入** — 与整个主机关机同时发生的历史写入可能在存储设施先关闭时丢失；插件重载会等待写入完成。
- **重启会遗忘失败状态** — 通知间隔、连续轮次失败和待发送的恢复消息都保存在内存中，因此跨越通知窗口边界的重启可能重复一条失败通知，重启前已通知的失败也不会有恢复消息。
- **从不注册的提供方不会被检查** — 路由检查要等提供方注册；在此之前只有事件会报告不可用的路由。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
