# Agent Note: 无人值守通道的模型选择

Status: implemented

[English](2026-09-27-unattended-lane-model-selection.md) | 中文

## 问题

Discord 对话、计划运行和 Web Session 对延迟与成本的要求不同。此前共享默认模型决定每个新入口 Session 的选择，而无人值守打开路径丢失了推理力度。把模型选择放在 preset 上也会影响使用同一组合的 Web Session。

## 决定

Discord 网关和 cron 配置都可以选择确切的 provider、model 与可选推理力度。已配置的 cron 任务可以覆盖 cron 顶层选择；持久任务继承该选择，持久记录无需改变。没有显式选择时，每个新 Session 读取完整的当前 `agentDefaultModel` 选择。显式选择在对话或 cron 运行打开 Session 时依据已注册的适配器解析，此时提供方行已挂载。不支持的路由或推理力度会报错并指明所属配置字段。

Discord 恢复时从 Session 日志读取最后一个完整的 `request/header`，并将其选择交给 Agent 恢复。没有请求头的 Session 回退到当前网关选择。因此，新配置只影响未来的对话与触发，不改变既有对话或 Web 模型选择器。普通 `request/header` 记录每个生成请求的有效选择；无需新增 Session 事件或迁移 cron 存储。

## 考虑过的替代方案

**把模型选择放在 preset 注册表。** 注册表负责组合与选择器元数据，而 Web 可以对同一 preset 使用用户选择的模型。注册表字段会耦合互不相关的入口。

**在每个 cron 任务中持久化模型覆盖。** 持久任务无需独立选择。覆盖仅位于已配置任务和 cron 行，避免修改持久任务格式或通过 `cron_manage` 公开模型选择。

**恢复时应用当前通道选择。** 这样会在配置编辑后悄悄改变对话。已记录的请求头足以标识应保留的路由和有效推理力度。

## 验证

单元测试覆盖默认继承、配置优先级、Agent 创建前拒绝不支持的推理力度、持久任务继承，以及 Discord 从日志恢复。无密钥的 cron 指引 Session 快照固定 `request/header` 中的有效推理力度；Web 默认模型测试覆盖其独立选择路径。

## 结果

操作者须为每条显式路由选择适配器支持的推理力度。官方 DeepSeek 路由不支持 `medium`；本地适配器可通过确切模型元数据公开它。验证在每次新对话或 cron 触发时运行，使适配器目录变更不能悄悄把任务导向不支持的选择。
