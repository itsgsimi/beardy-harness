# Agent Note: 摄像头分类只提出通知规则需要的问题

Status: implemented

[English](2026-09-28-camera-rule-questions.md) | 中文

## 问题

摄像头监视用一个小型视觉模型（Qwen3.5 4B，关闭思考）分类画面，它回答一个自由格式的判定：标签、数量、活动、车辆活动、自报的置信度和出现人物的画面。模型几乎对每个事件都报告 0.95 的置信度，因此 `policy.minConfidence` 过滤不掉任何东西。它分不清人行道上的路人和车道上的人，因此列在 `personDevices` 中的车库摄像头会因街上的行人而通知。它把刚驶入、车门还开着的车描述为 `parked`，因此到达没有被注意到。该判定要求模型用文字概括场景，规则再对这些文字重新解读。

## 决策

**每次分类只提出设备已启用规则会读取的是非问题。** 摄像头 Definition 用 `answers` 取代判定的 `activity`、`vehicleActivity`、`confidence` 和 `personFrames`：`person_on_property`、`person_at_door`、`person_staying`、`package_present`、`package_being_delivered`、`vehicle_arriving` 和 `vehicle_leaving`，每个都是 `{ answer, frames }`，附带显示它的从零开始的画面序号。标签、数量和最多 25 个词的描述保留下来，因为历史、`camera` 工具和车辆数量基准会读取它们。`askedQuestions` 从策略推导出问题集合：人物问题用于夜间、`personDevices` 和逗留规则；`person_at_door` 用于新的 `policy.doorDevices` 摄像头以及任何门铃按下，因为 Definition 不说明哪台设备是门铃；有两帧或更多画面时询问 `person_staying`；只有基准能说明包裹是新出现的时才询问 `package_present`；在 `vehicleDevices` 上，按 `vehicleActivities` 所列的每种动向询问车辆问题，该列表现在只有 `arriving` 和 `leaving`。第一帧检查不询问 `person_staying`、`package_present` 和 `vehicle_leaving`。指令为每个问题给出一行简短定义以及判定规则：人行道和街道不属于自家范围；在入口处亮着灯等待，或停着且车门打开、有人下车的车辆算作驶入；车门关着的停放车辆两者都不算。

**每台设备的场景告诉模型自家范围到哪里为止。** 监视配置中经过校验的 `devices: [{ id, scene? }]` 列表把每个场景原样插入为 `Scene: <文本>`。设备来自提供方，因此监视插件在启动时检查这些 ID，与检查策略列表的方式相同。README 给出前门和车库场景作为示例；由部署设置它们。

**依据画面取代置信度。** 没有有效依据画面的真回答读取为假，`policy.minConfidence` 已弃用：模式仍接受它，但会被忽略，并在加载时发出警告。规则把回答映射为原因：`person_on_property` 或 `person_at_door` 为真时算作看到人（`person`、`night-person`）；`package` 需要 `package_being_delivered`，或者在设备的基准记录对 `package_present` 回答为假时需要 `package_present`，因此两次事件之间留下的箱子只通知一次；`vehicle` 取车辆数量变化、`vehicle_arriving` 和 `vehicle_leaving` 中第一个被列出的动向；`lingering` 需要 `person_staying`，且人物依据画面跨越 `lingerSeconds`。基准是设备在 `arrivalBaselineMs` 内的最近一条记录，不再按置信度过滤。

**读取器是作用于提示并解析输出的逐字段模式。** 它保留容忍代码围栏和说明文字的对象查找，用 zod 校验每个字段，保留部分对象中有效的回答，并忽略未询问问题的字段。历史以追加方式存储回答：`answers` 默认为空，旧的判定字段变为可选，因此此变更之前写入的记录在存储域版本 1 下仍能解析，工具会显示它们已存储的字段。

**确切的请求是纯函数。** `renderClassificationRequest(config, event)` 针对所写的配置返回系统提示词、指令和问题，使重放脚本能在已存储事件上比较提示词；监视插件通过同一个 `classificationRequest` 构建每个请求。

## 考虑过的替代方案

**用模式强制的 JSON 和对数概率表示置信度。** LLM 接缝既不携带响应格式，也不携带对数概率；加入它们会改变核心调用配置和请求头。这是第二阶段，只有在这些问题仍留有缺口时才进行。

**保留 `minConfidence` 对回答的限制。** 一个始终为 0.95 的自报数字什么也限制不了；依据画面则可以核对。

**在每台设备上询问所有问题。** 用不到的问题浪费 token，也给小模型更多偏离模板作答的机会。

**在摄像头 Definition 中加入门铃标志。** 只有门口问题需要它，门铃按下本身已为该事件标明设备，而 `doorDevices` 覆盖没有按钮的门口摄像头。

**把场景放在提供方的设备列表上。** 场景是分类器拥有的提示词文本，不属于厂商适配器。

## 后果

人行道上的路人对 `person_on_property` 回答为假，不会触发任何通知；车道上或门口的人在人物设备上触发通知；停下后车门打开的车辆作为驶入触发通知。分类请求的指令约为 250 到 450 个 token，取决于场景和问题，通知也不再显示置信度。小模型仍可能跳过某个问题，此时该问题视为未回答，不会触发任何通知。测试固定了前门和车库的原文提示词、解析边界情况、策略映射、此变更之前写入的记录、包裹基准以及早期路径；`camera-watch` 会话快照固定了新的请求和回答。
