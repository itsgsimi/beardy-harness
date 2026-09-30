# Agent Note: 工作区迁移后的 Discord 恢复

Status: implemented

[English](2026-09-29-discord-resume-after-workspace-move.md) | 中文

## 问题

2026-09-29，部署把 Discord 默认通道的 `workspacePath` 从 `/home/goran/deepseek-harness` 移到 `/home/goran/.dsh/people/goran`。下一条消息恢复了该频道的持久对话记录，`Workspace.attachSession` 拒绝了它：`cannot attach session 'discord-…' to workspace '/home/goran/.dsh/people/goran': its cwd resolves to '/home/goran/deepseek-harness'`。Session 头部的 cwd 永不改变，因此之后每条消息都以同样方式失败并显示 "Request failed"，只有 New conversation 按钮能恢复该频道。

另外，每次 Discord 与摄像头 Agent 释放时都会记录两次 `agent/disposed listener threw: TypeError: Cannot read properties of undefined (reading 'catch')`。`@deepseek-ai/dsh-file-reference-local` 与 `@deepseek-ai/dsh-tool-subagent` 各自通过 `agent.ctx.inject` 安装一个 fiber，并在 `agent/disposed` 监听器中用 `fiber.dispose().catch(…)` 释放它。`agent/disposed` 触发时，Agent 自身的作用域已经释放了该子 fiber，而 Cordis 的 effect 释放函数只执行一次：重复调用返回 `undefined`，尽管 `Fiber.dispose` 的类型是 `() => Promise<void>`。

## 决策

`@deepseek-ai/dsh-discord-gateway` 在恢复之前比较已记录 Session 存储的头部 cwd 与通道的 `workspacePath`，两者都用 `@deepseek-ai/dsh-workspace` 的 `realpathNormalize` 规范化，与 `attachSession` 使用的规范一致。无法再解析的存储 cwd 视为不同工作区；没有 cwd 的头部以及无法解析的通道路径保持原有失败。不一致时，`resumeConversation` 在任何 Agent 恢复之前以内部的 `ConversationWorkspaceMovedError` 拒绝。随后 `ensureConversation` 记录迁移、删除频道记录、在通道工作区开启新对话，并在该消息的轮次运行之前通过常规 `notice` 路径发送 `WORKSPACE_CHANGED_NOTICE`（"Started a new conversation because my workspace changed; earlier conversations stay searchable."）。先前的 Session 只被读取。会话属于先前工作区的到期提醒会记录警告并保持休眠，与通道被移除时的结果相同，而不是每隔 `wakeRetryMs` 无限重试。

`@deepseek-ai/dsh-fantasy-reports` 的 `openCaller` 在该 Session 存储的 cwd 经 `path.resolve` 后等于 `workspacePath` 时保留 `fantasy-reports-<team>`。迁移后它创建或恢复 `fantasy-reports-<team>-<hash>`，其中 `<hash>` 是解析后路径 SHA-256 的前 8 位十六进制数字。报告历史归 profile 所有，因此跨越两个调用方。

两个 `agent/disposed` 监听器都用 `Promise.resolve` 包装释放函数的结果，这是 Cordis 自身处理可能重复的 fiber 释放时采用的形式，因此已释放的 fiber 会正常结束而不产生监听器失败，被拒绝的释放仍会到达监听器的警告。

## 考虑过的替代方案

**匹配附加错误文本。** 解析 `its cwd resolves to` 会把网关耦合到另一个包的诊断措辞，而且只能在 Agent 已恢复并回滚之后才做出反应。

**比较记录的 `workspacePath` 字段。** 记录保存的是配置路径，而不是规范化的 Session cwd，因此符号链接或不同写法的路径会与 `attachSession` 的检查不一致。

**用 fiber 状态守卫监听器。** 读取 Cordis fiber 内部状态来跳过释放，会重复单次释放函数已经做出的判断。

## 影响

其他持久 Session 所有者不会跨工作区变更恢复：cron 运行、webhook 投递与摄像头分类每次运行都开启新的 Session id，研究对账与目标驱动从不附加工作区，Web、ACP 与 headless 恢复作用于客户端指定的 Session，因此保持不变。测试覆盖重启后第一条消息时的默认通道与用户通道、无法解析的存储 cwd、一致的 cwd、无关的附加失败、无法解析的通道路径、休眠的提醒、fantasy 调用方切换，以及通过真实 Agent 释放触发的两个监听器。该通知只发送到 Discord，对模型不可见，因此没有快照变化。
