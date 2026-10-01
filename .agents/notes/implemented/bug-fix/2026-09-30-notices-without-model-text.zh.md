# Agent Note: 不含原始模型文本的通知

Status: implemented

[English](2026-09-30-notices-without-model-text.md) | 中文

## 问题

摄像头分类的回答不含 JSON 对象时读取为 `unparsed`，其通知会把回答的第一行发到用户的 Signal 或 Discord 目标。不遵守 JSON 模板的模型会回复 `Based on the three images provided, here is a breakdown…` 这样的说明文字或格式错误的 JSON，于是用户在家庭提醒中收到了原始模型输出。`camera` 模型工具把同一行作为事件描述返回，助手因此可以转述它。

## 决策

`unparsed` 读取结果的通知与其他没有判定的读取结果一样，用固定文字 `The camera check could not describe this event.` 代替描述。历史记录保留模型的第一行用于调试。`camera` 工具把这类事件描述为 `Not described: the vision answer could not be read.`，完全不返回原始文本，因为工具返回的任何文本都可能经由助手到达用户，而 `checked` 字段已写明 `unparsed`。

Fantasy 报告的阶段输出解析器在提取出的对象无法解析时抛出 JSON 解析器自身的消息，而该消息会引用阶段输出；它现在抛出 `the response JSON object does not parse`，因此运行的失败原因绝不携带模型文本。

其他通知路径本来就只组成有界的固定文字：摄像头失败通知引用路由解析错误的第一行（最多 200 个字符）或连续次数；健康探测通知写明固定原因或 HTTP 状态；`cronDeliveryContent` 只写明经过校验的失败代码、任务名、Session ID 和下次触发时间，从不包含 `failure.message`，Fantasy 报告的失败通知正是经由它到达用户。

## 考虑过的替代方案

- **在 `camera` 工具中把原始文本作为带标签的调试信息返回** — 被否决，因为助手仍可能向用户引用带标签的字段，而这正是此修复要消除的问题。
- **在通知中截断或清理原始文本** — 被否决，因为缩短后的说明文字或 JSON 片段仍是模型输出，而不是用户可以据以行动的陈述。

## 影响

摄像头通知、失败通知和定时运行失败通知都不会包含模型的回答。诊断 `unparsed` 事件需要查看其历史记录或分类 Session，而不是通知。
