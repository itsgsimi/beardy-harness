# Agent Note: 两个文件与一个工具构成的策划式跨会话记忆

Status: implemented

[English](2026-09-05-curated-memory.md) | 中文

## 问题

持久运行的 agent 会积累不属于任何单一会话的事实：用户是谁、用什么 shell、没有任务归属的约定。Session 日志其实什么都记着，但只能用于 recall——在每次请求时从上几百个 turn 里重新推导"用户偏好简短回答"，既花检索成本，也无法被策划或手工编辑。harness 需要一份小的、人可读的记录：廉价地进入每个新会话的 prompt、跨重启存活、模型自己能写（包括没有人在场确认的无人值守运行）。

## 决策

两个扁平 Markdown 文件加一个工具。`@deepseek-ai/dsh-tool-memory`（`packages/memory/tool-memory/`）只注册一个 `memory` 工具，编辑 `$DSH_HOME/USER.md`（关于用户的事实）与 `$DSH_HOME/MEMORY.md`（agent 自己的笔记），每次调用对单个条目做 add、replace 或 remove。每个文件都是严格 bullet list——任何非空行必须能按 `- text` 解析且不含控制字符——因此工具写出的内容读回来必然逐字一致；被手工编辑到漂移的文件会被点名文件和第一个坏行地拒绝，而不是被静默重写。字符上限（USER.md 1375、MEMORY.md 2200、单条目 400，均可配置）在写入前强制检查，每个结果都报告剩余预算，让模型做策划而不是无限追加。写入经由 `ctx.fs`：先拒绝符号链接，再做带版本校验的替换，事务前后发出 `fs/observed` 事件。

送达未来会话复用既有 seam：beardy preset 把两个文件名加进 `dsh-agent-instructions` 的 `userGlobalInstructionCandidates`，它们在会话启动时作为 user-global instruction 加载一次。memory 包从不自己注入，因此运行中会话的 prompt prefix——以及 KV cache——不被写入触碰。一个静态 `TOOL_MEMORY` prompt section 陈述声明性事实：两个文件各自的用途、写入只对后续会话生效、写满时的动作是 replace。设置 `requireApproval: true` 后，每次写入先向 `approval` service 提问，没有挂载 answerer 时直接拒绝，于是无人值守 preset 可以把记忆变更交给人工 answerer 裁决，而不是让一个 07:00 的 job 静默改写用户档案。

## 考虑过的替代方案

向量库或 embedding recall 被否决：这里的价值是一个能放进每个 prompt 的小而精选的集合，embedding 会引入检索质量无法人工审计的基础设施。`session_search` 已覆盖其余一切内容的 recall，并且继续是"不值得策划的内容去哪"的文档化答案。

每请求注入文件的专用 context plugin 被否决，因为 user-global instruction candidate 已经在会话启动时精确送达这段文本；第二个注入器要么重复它，要么制造两个真相来源，而在 re-render 时刻注入会让每次写入都搅动 prompt prefix。

合并成单文件被两文件切分否决：实践中用户事实与 agent 笔记的作者不同——用户会编辑 `USER.md`，并不期待自己的内容与 agent 的草稿笔记混排——且分开上限能防止一方饿死另一方。固定的两个目标名也让 path 选择从 tool schema 里消失，prompt injection 因此没有可瞄准的目标。

## 后果

挂载本包的每个 composition 每请求多带一个 tool schema；beardy profile 的每个新会话额外携带至多 3575 字符（两个文件上限之和）的 baseline instruction 文本。运行中的会话两者都不承担，因为送达是会话启动时的一次性加载。记忆写入可由既有 `tool/call` 与 `tool/result` 配对从会话日志重建，因此不需要新的 session event。被手工编辑到偏离 bullet 格式的文件会让工具停摆，直到有人修复被点名的那一行——拒绝而不自动修复是刻意的：静默规范化会覆盖人的意图。无人值守 preset 需要自己表态：设置 `requireApproval: true` 且没有挂载 answerer 时，无人值守运行期间记忆永不改变。
