---
description: "摄像头监视：每个摄像头事件一次记录在案的视觉模型分类、通知策略、附带画面的 Discord 通知、事件历史和 camera 工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-camera-watch

[English](README.md) | 中文

## 概述

只在重要的摄像头事件发生时收到提醒，其余时间保持安静。对每次门铃按下或移动警报，视觉模型在一次记录在案的轮次中只回答规则需要的是非问题，并引用画面：每次门铃按下、包裹送达、夜间或在指定摄像头上出现在自家范围内的人、驶入或驶离的车辆，以及停留的人。通知附带一帧画面发送到 Discord 频道；门铃按下或第一帧已足以触发通知的移动事件会先凭该帧通知。有界的事件历史供只读的 `camera` 模型工具作答。

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
| `earlyModelSelection` | 仅用于第一帧检查的精确路由，例如比 `modelSelection` 更快的模型；未设置时使用完整分类的路由；需要开启 `earlyMotionNotice` |
| `deliverChannelId` | 通知目标：Discord 频道 id、`discord:<id>`、`signal:group:<base64 id>` 或 `signal:number:<E.164>`；未设置时只保留历史 |
| `workspacePath` | 记录在分类 Session 上的绝对工作目录 |
| `policy.ding`、`policy.packageDelivered`、`policy.nightPerson` | 通知门铃按下、包裹送达和夜间出现在自家范围内的人（默认全部开启） |
| `policy.nightStart`、`policy.nightEnd` | 以本地 `HH:MM` 表示的夜间时段，默认 `21:00` 到 `06:00` |
| `policy.personDevices` | 任何时段有人出现在自家范围内都会触发通知的设备 ID，例如前门或车道；默认为空 |
| `policy.doorDevices` | 对着前门的设备 ID，其检查还会询问是否有人在门口；门铃按下在任何设备上都会询问；默认为空 |
| `policy.vehicleDevices` | 车辆驶入或驶离会触发通知的设备 ID |
| `policy.vehicleActivities` | 在这些设备上触发通知并被询问的车辆动向：`arriving` 和 `leaving`（默认两者都有） |
| `policy.lingerSeconds` | 停留的人出现的首尾画面之间达到多少秒算作逗留，默认 20 |
| `policy.minConfidence` | 已弃用且被忽略：配置了该值时加载时记录 `camera-watch: policy.minConfidence is deprecated and ignored; rules read the answers' evidence frames` |
| `policy.arrivalBaselineMs` | 作为同一设备基准、用于比较车辆数量和判断新出现包裹的更早事件的最大时间跨度，默认 12 小时（0 关闭两种比较，最多七天） |
| `devices` | 各设备设置 `{ id, scene? }`：`scene`（1 到 1000 个字符）说明该摄像头画面中各物的位置，原样插入其提示词 |
| `immediateDingNotice` | 分类前先发送带第一帧的门铃通知，再以后续消息发送分类后的通知；默认开启 |
| `earlyMotionNotice` | 单独分类移动事件的第一帧，若已足以触发通知则立即发送；完整分类只在有新增内容时才发送更新；默认开启，配置了频道时每个移动事件多一次分类 |
| `maxOutputTokens`、`turnTimeoutMs` | 每次分类请求的输出上限，以及每个分类轮次（包括纠正轮次）的时限 |
| `temperature` | 每次分类请求（包括第一帧检查）的采样温度，默认 0.2（0 到 2）；请求头会记录它 |
| `retryOnBadAnswer` | 回答没有 JSON 对象、什么都没说明或漏掉被询问的问题时，在同一 Session 中再问完整分类一次；默认开启，第一帧检查从不再问 |
| `maxConcurrent`、`maxQueued` | 同时进行的分类数（含第一帧检查），以及超出后排队等待的事件数 |
| `retentionDays`、`maxHistory`、`sweepIntervalMs` | 历史记录及其已存储画面的保留天数和条数上限，以及两次保留清理之间的间隔（一分钟到一天） |
| `deliveryAttempts`、`deliveryRetryMs` | 单条通知的交接尝试次数及间隔 |
| `failureNoticeThreshold`、`failureNoticeIntervalMs` | 连续多少次分类的最终轮次失败后发送失败通知，默认 3（1 到 100），以及两条失败通知之间的最短间隔，默认六小时（一分钟到七天） |
| `tool`、`toolMaxEvents` | 是否注册 `camera` 工具，以及单次结果的上限 |

`policy.personDevices`、`policy.doorDevices`、`policy.vehicleDevices` 或 `devices` 中不对应任何提供方设备的条目、在 `devices` 中出现两次的设备、为空或过长的场景、空的 `policy.vehicleActivities` 列表，以及在 `earlyMotionNotice` 关闭时设置的 `earlyModelSelection` 都会导致加载失败。模型路由不在加载时检查，因为提供方在监视插件之后注册。所有路由的提供方都注册后，监视插件会各解析一次每条路由（包括图像输入检查），并记录 `camera-watch: classifying with <provider>/<model>`；`earlyModelSelection` 指向另一条路由时其后追加 ` (first frame: <provider>/<model>)`。检查失败时记录以 `camera-watch: model route check failed:` 或 `camera-watch: first-frame model route check failed:` 开头、附带原因链的错误；完整路由失败而第一帧路由可用时记录 `camera-watch: first-frame checks classifying with <provider>/<model>`；检查失败不会中止主机。每个事件仍会解析路由：无法解析的路由使事件以 `MODEL_UNAVAILABLE` 记录，声明不接受图像输入的路由使事件以 `MODEL_NOT_VISION` 记录；门铃按下仍会发送通知。

根据摄像头的真实画面编写场景：门、步道、车道、人行道和街道出现在哪里，通常停着哪些车辆。下面是门铃和车库泛光灯摄像头的两个示例：

```yaml
devices:
  - id: front-door
    scene: >-
      Fisheye view. The front door is at the right edge, under a covered entry with a column. A paver walkway runs from the door
      to the driveway corner; a parked pickup is often visible past the column. The street and the houses across it are in the far background.
  - id: garage
    scene: >-
      Elevated view over the driveway. The concrete driveway fills the middle and bottom; the family pickup on the left and a sedan
      at the bottom right are usually parked there. The driveway meets the curb and street at the top middle. The sidewalk and street
      run across the top, with houses across the street. Pavers and shrubs are on the right.
```

路由检查失败、事件以 `MODEL_UNAVAILABLE` 或 `MODEL_NOT_VISION` 记录，或者连续 `failureNoticeThreshold` 次分类的最终轮次以 `TIMEOUT`、`TURN_FAILED`、`NO_ANSWER`、`EMPTY_ANSWER` 或 `SESSION_FAILED` 结束时，会向 `deliverChannelId` 发送一条失败通知，每个 `failureNoticeIntervalMs` 内最多一条：`⚠️ Camera classification is failing (<code>: <cause>). Motion alerts are paused; doorbell presses still post.` 路由失败时原因是最内层错误的第一行，轮次失败时原因是连续失败的次数；`policy.ding` 关闭时通知在 `Motion alerts are paused.` 处结束。失败通知之后第一次得到回答的分类会发送 `Camera classification recovered.`。未设置 `deliverChannelId` 时两者只写入日志，分别为 `camera-watch: classification is failing (<code>: <cause>)` 和 `camera-watch: classification recovered`。未设置 `earlyModelSelection` 时，第一帧检查与完整分类一样计入这些通知。设置后，第一帧检查有自己的连续失败计数、间隔和通知，因此失败的快速模型不会暂停移动提醒：`⚠️ Camera first-frame checks are failing (<code>: <cause>). Motion alerts wait for the full check.` 和 `Camera first-frame checks recovered.`，日志分别为 `camera-watch: first-frame checks are failing (<code>: <cause>)` 和 `camera-watch: first-frame checks recovered`。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

事件按 ID 排队；重复的 ID 或未知设备会被忽略。同时最多运行 `maxConcurrent` 个分类；已有 `maxQueued` 个事件在等待时新到的事件不经分类记录为 `QUEUE_FULL`。没有画面的事件跳过分类，记录为 `NO_FRAMES`。

每次分类都会打开一个不带 agent 预设的根 Session，每个轮次只允许一次模型请求，最多两个轮次。其 Agent 作用域把分类提示词注册为人设前缀段中的完整系统提示词，因此主机人设和其他所有段都被排除；抑制运行时上下文；通过 `system-prompt/assemble` 监听器去掉所有工具模式，这也覆盖其他插件在创建后注册到该 Agent 自身作用域的工具，例如 schedule 工具；并通过作用域内的工具守卫拒绝所有工具执行。提示词作为该 Session 的系统消息进入日志，请求头不记录任何工具。它唯一的其他输入是一条来源类型为 `camera` 的 `user/message`：提示文本加上作为图像块的画面。已完成的助手文本按每个字段的模式读取：取文本中的第一个 JSON 对象，即使它位于代码围栏或说明文字中；标签接受常见同义词和复数；每个被询问的问题必须是带布尔值 `answer` 和 `frames` 列表的对象，超出画面范围的画面序号会被丢弃。没有有效依据画面的真回答读取为假，没有有效对象的被询问问题不计入回答，未询问问题的字段会被忽略；关于人物、包裹或车辆的真回答会补上对应标签。所有字段有效时读取结果为 `parsed`，部分字段有效时为 `partial`，没有 JSON 对象时为 `unparsed` 并保留第一行文本。什么都没说明的对象（没有描述或描述为空白、没有标签、没有计数，且没有被询问的问题回答为真）不算读取结果：原样返回模板的模型就是这样回复的，因此该分类以 `EMPTY_ANSWER` 失败，并记录 `camera-watch: classification <session id> of <event id> stated nothing`，而不是读取为什么都没发生。开启 `retryOnBadAnswer` 时，如果完整分类的第一个回答为 `unparsed`、什么都没说明，或为漏掉被询问问题的 `partial`，就在同一 Session 中再发送一条 `user/message`：`Your reply was not the JSON object. Reply with only the JSON object from the instructions, filled in.`，并保留两个读取结果中更可用的一个：`parsed` 高于 `partial`，回答了更多被询问问题的 `partial` 高于回答较少的，`partial` 高于 `unparsed`，`unparsed` 高于 `empty`，两者相当时保留纠正后的读取结果。失败的纠正轮次（例如 `TIMEOUT`、`TURN_FAILED` 或 `NO_ANSWER`）回退到第一个 `partial` 读取结果，否则记录它自己的失败代码。监视器记录 `camera-watch: classification <session id> of <event id>`，后接 `kept its corrective answer`、`kept its first answer after a worse retry` 或 `kept its first answer after the corrective turn failed (<code>)`。回答了所有被询问问题的 `partial` 第一个回答不进行纠正轮次，保持不变。失败代码和失败通知计数只读取保留的读取结果。第一帧检查从不再问，因此其提前通知保持原有延迟，完整分类仍会随后进行。每次请求都通过 `agent/request` 监听器带上 `temperature`（默认 0.2），因此请求头会记录它。模型自己的置信度既不询问也不读取。轮次失败记录为 `TIMEOUT`、`TURN_FAILED`、`NO_ANSWER`、`EMPTY_ANSWER`、`NOT_PERSISTED`、`SESSION_FAILED`、`MODEL_UNAVAILABLE` 或 `MODEL_NOT_VISION`。

第一帧检查与其他分类共用 `maxConcurrent` 个槽位。`earlyMotionNotice` 开启且配置了频道时，新移动事件的 `camera/preview` 会排入一次仅针对该帧的检查，除非所有槽位都忙且已有 `maxQueued` 个事件在等待；排队中的检查先于任何排队中的事件启动，因此事件不会排在自己的检查之前而等待它。该检查是独立的、记录在案的分类 Session，其来源摘要以 `(first frame)` 结尾，指令说明图像只是第一帧；除 `person_staying`、`package_present` 和 `vehicle_leaving` 外，它提出相同的问题，设置了 `earlyModelSelection` 时使用该路由。失败或回答为空的检查不发送早期通知，完整分类仍会运行并自行通知。其判定产生原因时，通知 `camera:<事件 ID>:early` 立即附带该帧发送，并以 `From the first picture; an update follows only if the rest shows more.` 结尾。逗留原因需要两帧，因此从不来自此检查，下文的基准比较也只用于完整分类。同一事件的完整分类会等这条通知结束后再进行。早期通知送达后，分类通知 `camera:<事件 ID>` 只在有新增内容时发送：早期通知未说明的原因，或任一标签的数量高于第一帧；此时其标题为 `<时间> (update)`。原因相同且数量持平或更少时不发送任何消息，因为两次回答很少用相同措辞描述同一场景。历史把该检查的 Session 记录为 `earlySessionId`，得到回答时把其原因记录为 `earlyReasons`，把其交接结果记录为 `earlyDelivery`；无需更新时 `delivery` 保持为 `none`。

每次分类只提出设备已启用规则会读取的问题：`person_on_property` 用于夜间规则、`personDevices` 和逗留规则；在 `doorDevices` 摄像头上以及任何门铃按下时再加上 `person_at_door`；有两帧或更多画面时询问 `person_staying`；`packageDelivered` 开启时询问 `package_being_delivered`，`arrivalBaselineMs` 不为 0 时还询问 `package_present`；在 `vehicleDevices` 摄像头上，按 `vehicleActivities` 所列的每种动向询问 `vehicle_arriving` 和 `vehicle_leaving`。策略在代码中执行。门铃按下总会产生 `ding`。其他原因都需要 `parsed` 或 `partial` 判定。`person_on_property` 或 `person_at_door` 为真时算作看到人，因此人行道或街道上的路人不会触发任何通知。`night-person` 需要夜间时段内看到人，`person` 需要在任何时段于 `personDevices` 摄像头上看到人。`package` 需要 `package_being_delivered`，或者在下文基准对 `package_present` 回答为假时需要 `package_present`，因此两次事件之间留下的包裹只通知一次，一直放着的包裹不会再次通知。`vehicle` 需要 `vehicleDevices` 摄像头，并取车辆数量变化、为真的 `vehicle_arriving` 和为真的 `vehicle_leaving` 中第一个列在 `vehicleActivities` 里的动向；停下后车门打开或有人下车的车辆回答 `vehicle_arriving`，停放的车辆两者都不回答为真。`lingering` 需要为真的 `person_staying`，并且人物依据画面按记录的偏移跨越至少 `lingerSeconds`。基准是同一设备在 `arrivalBaselineMs` 内带有判定的最近一条更早记录，在设备是 `vehicleDevices` 摄像头或事件回答了 `package_present` 时比较：车辆多于基准视为 `arriving`，少于基准视为 `leaving`，该动向决定标题，例如 `Vehicle arriving`。历史保留判定，数量不同时追加 `vehicleChange`，比较过基准时追加 `baselineEventId`。`person` 通知的标题为 `Person at <设备标签>`；同时适用 `night-person` 时，历史记录和 `camera` 工具保留两个原因，通知只显示 `Person at night`。

当 `immediateDingNotice` 和 `policy.ding` 开启且配置了频道时，新门铃按下的 `camera/preview` 会立即把 ID 为 `camera:<事件 ID>:ding`、文本为 `Someone rang the doorbell`、带第一帧的通知交给 `camera/notice`。同一事件分类后的通知会等这次交接结束后再发送，因此排在第二条。历史记录在分类通知投递之前写入。分类后的通知包含设备标签、本地时间、原因、描述或缺少描述的原因，以及数量；展示的画面是第一张人物依据画面，否则是第一张画面，若已送达的即时通知已展示过该画面则不再附带。`camera/notice` 是串行事件，由目标传输方式的所属方认领：Discord 网关把 Discord 目标接入发件箱，发件箱上传经校验的已存储画面及文本；signal-notices 把 Signal 目标排入 Signal 发件箱。无监听器接收时监视插件会重试交接，把分类通知的投递结果记录为 `delivered`、`undelivered`、`no-channel` 或 `none`，并在尝试过即时通知时把其结果记录为 `earlyDelivery`（`delivered` 或 `undelivered`）。首次发布之后新增的历史字段都是可选的或带默认值，因此早期记录仍能解析：规则问题出现之前存储的判定读取为空回答，并保留其自身的活动、车辆活动、置信度和人物画面，任何规则都不读取它们。保留清理在启动时运行，此后每次在上一次清理结束 `sweepIntervalMs` 后再次运行。它删除每条超过 `retentionDays` 或超出 `maxHistory` 的记录，并通过 `ctx.attachments.deleteImage` 删除既不被保留记录引用、也不被未完成事件引用的画面。记录的某张画面删除失败时，该记录会保留，由下一次清理重试；已经不存在的画面视为已删除。删除了内容的清理会以 info 级别记录事件数和画面数。画面被删除时仍在 Discord 发件箱中等待的通知只发送文本。

所有路由的提供方在启动时都已注册则立即检查路由，此后在每次使它们全部注册的 `llm/adapters-updated` 时检查：提供方是 `modelSelection` 的提供方，未设置时是当时主机默认模型的提供方，以及设置了 `earlyModelSelection` 时它的提供方。只有某个提供方离开注册表后再次出现，才会再次检查。失败状态只保存在进程内，完整分类一份；设置了 `earlyModelSelection` 时，第一帧检查另有一份。每次得到回答的分类都会结束其所属状态中连续的轮次失败；`NOT_PERSISTED`、`NO_FRAMES`、`QUEUE_FULL` 和路由失败既不延续也不结束它。失败通知的 ID 为 `camera-watch:classification-failing:<窗口起点>`，使用自己路由的第一帧检查则为 `camera-watch:first-frame-failing:<窗口起点>`，窗口是包含该通知、按 Unix 纪元对齐的 `failureNoticeIntervalMs` 时段，恢复消息在其后追加 `:recovered`；Discord 发件箱会忽略已持有的 ID，因此在同一窗口内重启不会重复发送该通知。失败和恢复通知不带画面，沿用事件通知的交接重试，也不写入历史。历史是唯一的持久状态，所有写入都经过存储域，进程内的失败状态也没有可与之分歧的独立观测，因此不发布不变量组件。

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

每个事件以及每次移动事件的第一帧检查都使用一个独立的根 Session，其完整系统提示词是下方的固定文本，没有运行时上下文，也没有工具。它收到一条用户消息：下方的指令，然后是按截取顺序排列的事件画面图像。指令第一行说明警报（`doorbell press` 或 `motion alert`）、设备标签、本地日期时间、画面编号，以及每帧画面以整秒计的偏移；第一帧检查则说明图像是第 0 帧、只是第一帧、其偏移，以及后续画面另行检查。配置了场景时，其后是 `Scene: <文本>` 和一个空行。JSON 模板在 `description`、`labels` 和 `counts` 之后只列出被询问的问题，每个写作 `{"answer":false,"frames":[]}`；下方的问题行只对被询问的问题出现，最后一行只在询问车辆问题时出现。

##### 系统提示词原文

```markdown
You check still frames from a home security camera.
The user message states the alert and shows the frames. Reply with exactly the one JSON object it asks for and nothing else.
You have no tools. Describe people only by what is visible and never guess who anyone is.
```


##### 场景之后的原文指令（询问全部问题时）

```markdown
Reply with only this JSON object, filled in, and no other text:
{"description":"","labels":[],"counts":{},"person_on_property":{"answer":false,"frames":[]},"person_at_door":{"answer":false,"frames":[]},"person_staying":{"answer":false,"frames":[]},"package_present":{"answer":false,"frames":[]},"package_being_delivered":{"answer":false,"frames":[]},"vehicle_arriving":{"answer":false,"frames":[]},"vehicle_leaving":{"answer":false,"frames":[]}}

- description: one sentence of at most 25 words about what happens. Never guess who anyone is.
- labels: each of "person", "vehicle", "package", "animal" visible in any frame.
- counts: the most of each label visible at once, for example {"person":1}.
- Each question has "answer" (true or false) and "frames" (the frame numbers that show it). A true answer must list at least one frame. When no frame clearly shows it, answer false.
- person_on_property: a person is on the porch, walkway, yard, or driveway. A person only on the sidewalk or street is false.
- person_at_door: a person stands at the front door or within one step of it.
- person_staying: a person on the property stays in view in two or more frames instead of walking past.
- package_present: a package, box, or delivery bag lies on the property.
- package_being_delivered: a person carries a package onto the property or sets one down.
- vehicle_arriving: a vehicle pulls into the driveway, waits at its entrance with its lights on, or stands in it with a door open or a person getting out.
- vehicle_leaving: a vehicle backs or drives out of the driveway toward the street.
- A vehicle that stays parked with its doors closed and nobody at it is neither arriving nor leaving; a vehicle driving along the street is neither.
```

#### Token 影响

每个事件发出一次请求，运行纠正轮次时为两次：约 60 个系统提示词 token、约 250 到 450 个指令 token（取决于场景和被询问的问题），以及每帧一张图像（默认三帧），输出受 `maxOutputTokens` 限制。第一帧检查再增加一次请求，提示词相同，只带一张图像；设置了 `earlyModelSelection` 时使用该路由。

#### KV Cache 影响

每次分类都是新的 Session，因此除系统提示词外，事件之间不共享前缀。

### Camera 工具

#### 模型看到的内容

一个 `camera` 模式，带可选参数 `camera`、`hours`、`limit` 和 `notified_only`（[模式](../../../docs/tool-catalog.zh.md#deepseek-aidsh-camera-watch)）。结果是 JSON 文本，包含时区、时间窗口、匹配总数，以及按时间从新到旧排列的事件：ID、本地时间、摄像头标签、类型、描述、标签、数量、每个已回答问题及其回答、分类状态、是否有任何通知已送达，以及原因。规则问题出现之前分类的事件显示其已存储的活动、车辆活动和置信度，而不是回答。

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
- **到达判断需要基准** — 车辆摄像头上 `arrivalBaselineMs` 内的第一个事件（按默认 12 小时，例如每天早上的第一个）没有可比较的对象，模型在任一事件中数错的车辆都会被视为到达或离开。同一设备的两个事件同时分类时，都与两者之前写入的记录比较。
- **第一帧通知只凭一张画面** — 早期通知可能提到事件其余画面并未证实的人或车辆；更新只补充新原因和更高的数量，从不撤回早期通知。
- **回答靠提示词约束，而非模式强制** — 分类请求不携带响应模式，也不带 token 对数概率，因此小模型仍可能跳过问题或偏离模板作答；这样的回答读取为 `partial`，其缺失的问题不会触发任何通知。因此规则读取依据画面，而不是置信度（[决策](../../../.agents/notes/implemented/feature/2026-09-28-camera-rule-questions.zh.md)）。
- **空回答检查只识别空对象** — 原样返回模板但写了描述或抄了标签的模型，会被读取为所有问题都为假的真实回答。在 32 个已存储事件上重放时，Qwen3.5 4B 在两个多帧事件上原样返回了模板，Flash Next 从未如此，所以第一帧检查可以用小模型，而完整分类需要较大的模型（[决策](../../../.agents/notes/implemented/feature/2026-09-28-camera-rule-questions.zh.md)）。
- **人行道的判断依赖场景** — 没有 `scene` 时，模型只能从画面本身推断自家范围的边界。
- **不识别身份** — 判定只泛指人物；识别熟人需要另外的、需主动开启的人脸库。
- **历史只读文本** — `camera` 工具返回描述，不返回已存储的画面。
- **关机时的写入** — 与整个主机关机同时发生的历史写入可能在存储设施先关闭时丢失；插件重载会等待写入完成。
- **重启会遗忘失败状态** — 通知间隔、连续轮次失败和待发送的恢复消息都保存在内存中，因此跨越通知窗口边界的重启可能重复一条失败通知，重启前已通知的失败也不会有恢复消息。
- **从不注册的提供方不会被检查** — 路由检查要等所有路由的提供方都注册，因此缺席的第一帧提供方也会推迟完整路由的检查；在此之前只有事件会报告不可用的路由。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

要在已存储事件上比较提示词，用 `renderClassificationRequest(config, { device: { id, label }, kind, occurredAt, offsetsMs, firstFrame? })` 渲染确切的请求：`config` 是 `cordis.yml` 中所写的 camera-watch 配置，按加载时的规则校验，但不会对照提供方检查设备 ID。它返回 `{ systemPrompt, prompt, questions }`；把提示词和已存储的画面发给模型，再把回复、画面数量和 `questions` 传给 `parseVerdict`，并把判定传给 `noticeReasons`。该函数是纯函数，不发起任何模型或网络调用。

</details>
