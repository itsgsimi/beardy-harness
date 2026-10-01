# Agent Note: 摄像头分类重试

Status: implemented

[English](2026-09-30-camera-classification-retry.md) | 中文

## 问题

2026-09-30，在关闭思考的 Flash Next 路由上进行的 26 次完整摄像头分类中，17 个回答读取为 `parsed`，5 个为 `partial`，2 个因模型原样返回指令模板而为 `EMPTY_ANSWER`，2 个因模型写了 "Based on the three images provided, here is a breakdown…" 这样的说明文字而不是 JSON 对象而为 `unparsed`。用同一模型和提示词离线重放 32 个事件时全部 32 个回答正确，因此错误回答来自该路由默认温度 0.7 下的采样，而不是提示词。

## 决策

`@deepseek-ai/dsh-camera-watch` 通过分类 Agent 作用域中的 `agent/request` 监听器，为每次分类请求设置经过验证的 `temperature`，默认 0.2，范围 0 到 2。`AgentOptions` 没有温度字段，而该监听器是修改调用配置的既定方式；记录的 `request/header` 会像 `maxTokens` 一样带上该值。一个字段同时覆盖完整分类和第一帧检查，因为两者读取的是同一个 JSON 对象。

开启 `retryOnBadAnswer`（默认开启）时，如果完整分类的第一个回答读取为 `unparsed`、`empty`，或为漏掉被询问问题的 `partial`，就在同一 Session 中再发送一条 `user/message`："Your reply was not the JSON object. Reply with only the JSON object from the instructions, filled in." 监视器保留两个读取结果中更可用的一个，排序为 `parsed` 高于 `partial`，回答了更多被询问问题的 `partial` 高于回答较少的，`partial` 高于 `unparsed`，`unparsed` 高于 `empty`；两者相当时纠正后的读取结果胜出。直接失败的纠正轮次（`TIMEOUT`、`TURN_FAILED`、`NO_ANSWER` 或 `NOT_PERSISTED`）回退到第一个 `partial` 读取结果。监视器会记录它保留了哪个读取结果。`classify.ts` 中的 `llm/stream` 守卫对每条已发送的提示只允许一次模型请求，因此一次分类最多发出两次请求，而在一个轮次内再次询问模型仍会使该轮次失败。失败代码和失败通知计数只在保留的读取结果为失败时适用：在 `unparsed` 或 `empty` 第一个回答之后超时的纠正轮次记录为 `TIMEOUT`，两个空回答记录为 `EMPTY_ANSWER`。回答了所有被询问问题的 `partial` 回答保持不变，因为它的缺漏在标签、计数、描述或依据画面中，而规则可以容忍这些缺漏。

第一帧检查从不重试。它们唯一的用途是提前通知，纠正轮次会使其延迟加倍，而同一事件的完整分类无论如何都会随后进行。

## 考虑过的替代方案

**在 `AgentOptions` 上增加温度字段。** 这会为一个使用方修改核心 Agent API，而 `agent/request` 瀑布已经负责调用配置的提议。

**单独的 `earlyTemperature`。** 两个路由回答的是同一种 JSON 格式，没有证据表明第一帧路由需要不同的采样设置。

**始终保留纠正后的回答。** 采样更差的重试（例如 `partial` 回答之后的空对象）会把可用的结论变成失败，而这正是重试要吸收的漂移。

**在新 Session 中重试。** 新 Session 需要重新发送画面，并且会丢失纠正消息所指的模型自身的错误回答。

## 影响

纠正轮次在同一 Session 中多花一次请求，新消息不带图像但带有第一个轮次的历史，并再等待最多 `turnTimeoutMs`。测试覆盖：对说明文字、空对象和漏掉问题的重试；对 parsed 回答以及回答了所有问题的 partial 回答不重试；排序，包括第一个 `partial` 优先于空的重试、`unparsed` 第一个回答被 `partial` 重试取代，以及两个空回答以 `EMPTY_ANSWER` 失败；纠正轮次失败或超时时保留第一个 `partial`，以及 `unparsed` 第一个回答之后纠正轮次的失败代码；请求和记录的请求头中的温度；失败通知计数只计最终回答；以及配置验证。`camera-watch` 会话快照在其请求头中记录该温度。
