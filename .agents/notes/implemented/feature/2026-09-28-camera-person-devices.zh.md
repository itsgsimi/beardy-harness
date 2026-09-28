# Agent Note: 摄像头监视对选定摄像头上的任何人发出通知

Status: implemented

[English](2026-09-28-camera-person-devices.md) | 中文

## 问题

摄像头监视插件只在夜间时段内（`night-person`）或出现人物的画面跨越至少 `lingerSeconds`（`lingering`）时才为人物发出通知。白天走到前门、几秒内离开的访客不会产生通知。家庭希望前门摄像头看到的每个人无论白天黑夜都被报告，而车库摄像头保持严格的只针对车辆的规则。

## 决策

**按设备列出，而不是全局开关。** `policy.personDevices`（默认为空）列出任何时段带有 `person` 标签的判定都会触发通知的设备 ID。它与其他判定规则经过相同的门槛：置信度不低于 `minConfidence` 的 `parsed` 或 `partial` 判定。它与 `policy.vehicleDevices` 对称：条目会去重，不对应任何提供方设备的条目会在加载时以 `camera-watch: policy.personDevices names unknown camera device "<id>"` 失败。部署只需添加 `policy: { personDevices: [front-door] }`。

**在 `night-person` 之后的独立 `person` 原因。** 规范顺序为 `ding`、`package`、`night-person`、`person`、`vehicle`、`lingering`。`person` 与 `nightPerson` 相互独立，因此关闭夜间规则仍保留设备规则。两者同时适用时，历史记录和 `camera` 工具保留两个原因，因为每个原因都表示一条匹配的规则；通知只渲染一个标题 `Person at night`，因为第二个 `Person at <设备标签>` 只会重复同一事实。单独出现时，标题为 `Person at <设备标签>`，例如 `Person at Front door`。

**历史记录的增量变更。** 存储的原因枚举增加 `person`，并与原因类型一样从同一个 `NOTICE_REASONS` 列表派生。此前写入的记录仍可解析，因此存储域版本保持为 1。

## 考虑过的替代方案

**全局 `anyPerson` 开关。** 它也会对车库摄像头上的每个人发出通知，而家庭希望车库保持安静。

**按设备设置夜间时段。** 覆盖全天的时段可以表达该规则，但零长度或全天的时段不能清楚地表达“始终”。

**把设备规则并入 `night-person`。** 历史记录会丢失匹配的是哪条规则，而且中午的设备规则通知会显示为 `Person at night`。

## 影响

列入名单的前门摄像头会为每个达到置信度的人物判定发送通知，包括它能看到的人行道上的路人；`minConfidence` 是唯一的过滤条件。更早构建的历史模式不接受带有 `person` 的记录，因此一旦存在此类记录，就不支持回退到此变更之前。

策略测试固定了列出设备上的白天通知、未列出设备上以及低于置信度下限时保持安静、夜间两个原因同时存在，以及关闭 `nightPerson` 时的设备规则。监视插件测试固定了端到端的通知文本、车库保持安静，以及未知 ID 的加载失败；历史测试固定了旧记录和新记录。`camera-watch` 会话快照没有变化，因为其配置没有列出人物设备。
