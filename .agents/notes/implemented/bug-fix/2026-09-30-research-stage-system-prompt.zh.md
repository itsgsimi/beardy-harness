# Agent Note: 研究阶段的专用系统提示词、温度与 JSON 纠正轮次

Status: implemented

[English](2026-09-30-research-stage-system-prompt.md) | 中文

## 问题

2026-09-30，最近四次 Fantasy 审阅阶段全部以散文加一个写成文本的工具调用作答，例如 `<tool_call><function=session_search>…`、`web_search` 调用或一条 shell 命令，因此工作流以 `the reviewer returned no usable findings JSON: Error: issues must be an array` 或 `the response contains no JSON object` 扣留了报告。每个研究阶段 Session 都没有工具，但仍收到部署的通用 Agent 系统提示词（3157 个字符，介绍一个编码 Agent 并要求它使用 `session_search`）以及运行时上下文。模型遵循了该提示词，而不是阶段消息。摄像头分类曾出现同样的故障，并已改为依据专用的完整系统提示词作答。

## 决策

`@deepseek-ai/dsh-dedicated-prompt` 中的 `installDedicatedPrompt` 承载摄像头分类所用的机制：一个遮蔽部署人设前缀的完整段落、被抑制的运行时上下文、一个丢弃所有工具 schema 的 `system-prompt/assemble` 监听器，以及一个设定温度的 `agent/request` 监听器。摄像头分类和研究阶段都调用它；各自保留自己的工具守卫和拒绝文本。它位于 Beardy 维护的包中，因为它只需要公开的系统提示词服务和 `agent/request` 事件，因此任何上游包都无需承载它（[承载规则](../architecture/2026-10-07-downstream-carry-into-plugins.zh.md)）。

每个研究阶段 Session 现在依据 `You are one stage of a research workflow. You have no tools and cannot search, browse, or run commands; work only from the text in the user message. Follow the output format the message asks for exactly.` 作答。`ResearchWorkflow` 可以提供自己的 `stageSystemPrompt`（1 到 4000 个字符）；Fantasy 工作流说明它是 Fantasy 报告的撰写、审阅或修复阶段，没有工具，并且每个回答都是一个 JSON 对象。除非工作流为某个阶段传入 `temperature`，每个阶段请求都带有 research-local 的 `stageTemperature`，默认 0.2，验证范围为 0 到 2。通用提示词版本变为 `odysseus-general-v2`，Fantasy 提示词版本变为 `fantasy-weekly-v4`。

`ResearchWorkflowRun.stage` 接受可选的 `expectJson` 检查。检查拒绝首个回答时，同一阶段 Session 会收到 `Your reply was not the requested JSON. Reply with only the JSON object in the requested format.`，并且仅当纠正回答通过检查时阶段才返回它；未结束、为空或仍不合格的纠正回答会让首个回答保留为结果。单次模型请求守卫现在按轮次计数，因此一个阶段最多发出两次请求。Fantasy 的撰写、审阅和两种修复阶段用稍后读取回答的同一解析器构建检查，因此检查恰好接纳工作流接受的内容。纠正轮次失败后，工作流自身的重写、结构修复和第二次尝试策略照常适用。

## 考虑过的替代方案

- **在 Fantasy 工作流内重试** — 已否决，因为工作流只能打开新的阶段 Session；纠正轮次必须在自己的 Session 中看到错误回答才能纠正它。
- **在 research-local 中使用固定的 JSON 形状检查** — 已否决，因为只有工作流知道自己的形状；谓词让 research-local 不依赖 Fantasy 类型。
- **在阶段 `llm/stream` 守卫中保留请求时的工具 schema 检查** — 已否决，因为组装监听器在请求生成之前就移除所有工具 schema，该检查已不可能失败。
- **把辅助函数放进 `dsh-unattended-session`** — 已否决，因为 research-local 会为四个监听器继承该包的预设、权限和标题依赖。

## 影响

阶段日志把阶段系统提示词显示为 Session 的系统消息，并在请求标头中记录温度，因此每个模型可见输入都可重建。以散文或伪工具调用作答的阶段会先在同一 Session 中得到一次低成本纠正，然后工作流才花费重写、修复或第二次审阅。通用研究引擎尚未传入 JSON 检查，因此其阶段不会被纠正。
