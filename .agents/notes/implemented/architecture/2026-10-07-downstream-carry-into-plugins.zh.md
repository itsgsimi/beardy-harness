# Agent Note: 下游代码放在下游包中

Status: implemented

[English](2026-10-07-downstream-carry-into-plugins.md) | 中文

## Problem

本分支把 `origin/master` 同步进一个额外加入 Beardy 包的代码树。0.2.1 同步在 99 个路径上发生冲突。几乎所有需要手工解决的冲突都位于被 Beardy 工作修改过的上游包中，而不在 Beardy 包中。每处此类修改在每次同步时都要重新合并，而藏在上游组合包行中的修改可能在合并时被静默丢弃。

## Decision

Beardy 代码放在 Beardy 维护的包和 `dsh-beardy` 组合包中。只有当没有公开扩展点能承载某项行为时才修改上游文件，且每处剩余修改都列在下方的承载清单中，并注明可移除它的上游改动。

以下迁移应用了该规则：

| 行为 | 迁出的上游文件 | Beardy 所有者与扩展点 |
|---|---|---|
| 默认禁用的 `speech-whisper` 行与 `ui-voice` 听写行 | `bundle/base`、`bundle/web-app` 的 patch 与清单 | `bundle/beardy` patch，以相同行 id 插入，因此 profile 层仍按 id 替换 `speech-whisper` |
| 面向单一用途 Agent 作用域的 `installDedicatedPrompt` | `core/agent` | `prompt/` 包组中的新包 [`dsh-dedicated-prompt`](../../../../packages/prompt/dedicated-prompt/README.zh.md)；使用 `systemPrompt.section({ complete })`、`suppressRuntimeContext()` 以及 `system-prompt/assemble` 与 `agent/request` waterfall |
| 记忆提示词分节顺序 | `core/system-prompt` 中的 `TOOL_MEMORY` | `dsh-tool-memory` 导出 `MEMORY_SECTION_ORDER = 2350` 并作为 `order` 传入 |
| `LOCAL_MODEL_UNLOADED` 检查 | `llm/llm-pi-ai` 中的 `checkRoute` 闭包与导入 | [`dsh-local-model-control`](../../../../packages/health/local-model-control/README.zh.md) 中一个前置注册、读取最终 provider 路由的 Host `agent/request` 监听器 |
| webhook 入口的无人值守开启 | `webhook/webhook` 对 `dsh-unattended-session` 的导入 | 已移除；webhook 保留上游的内联开启流程，cron 与 Discord 继续使用共享库 |
| `beardy` profile 模板 | `boot/app-boot` 的 `PROFILE_TEMPLATES` | profile 自身的 `package.json` 列出其三个组合包层 |
| `encodeSegment` 子路径导出 | `session/session-persistence-jsonl` | `experimental/training-export` 中的副本，并通过测试与 JSONL 编码器比对 |
| `TEXT_TOOL_OUTPUT` 输出声明 | `core/tools` | `prompt/` 包组中的新包 [`dsh-text-tool-output`](../../../../packages/prompt/text-tool-output/README.zh.md)；`tool-fantasy` 与 `camera-watch` 在 `defineTool` 旁导入它 |
| `activeApprovalRequestId` 请求到 id 的映射 | `interaction/user-approval` | `discord-gateway` 把已记录的 `approval/asked`/`approval/decided` 对折叠为仅主机可见的 `discordApprovalAsks` Session 投影，并认领与请求的工具、调用 id 和原因相同的最早未决问题 |
| `skill_manage`、技能提醒、它们的六个配置字段以及被裁剪技能的重新加载指引 | `skill/tool-skill` | 与 `tool-skill` 并列的新行 [`dsh-tool-skill-manage`](../../../../packages/memory/tool-skill-manage/README.zh.md)；该指引从目录消息移到其自身的 `tool:skill-manage` 提示词分节 |
| `deep_research`/`odysseus_research` 报告行与研究工作模型设置标签页 | `client/ui-tool` 工具视图、`client/ui-settings-plugins` 标签页，以及 `client/ui-conversation` 中的 `research.*` 键 | Beardy 组合包中的新 `dsh.client` 行 [`dsh-client-ui-research`](../../../../packages/research/client-ui-research/README.zh.md)；带键的 `tool.call.toolview` 条目与一个 `settings.plugins.tab` 条目，使用公开的 `DisclosureRow` 原语渲染 |
| 内联 `presented-visual` 聊天节点 | `client/ui-deliverables` | Beardy 组合包中的新 `dsh.client` 行 [`dsh-client-ui-visuals`](../../../../packages/visuals/client-ui-visuals/README.zh.md)；一个 `ctx.uiConversation.events` 定义与一个带键的 `conversation.chat.node` 条目 |

`skill-nudge` 消息来源以相同的 `@persistenceAttribution` 声明迁入 `dsh-tool-skill-manage`。其摘要未变，因此持久化目录只记录新的源码位置，无需持久化变更记录。

### 承载清单

| 保留的上游修改 | 规模 | 可移除它的上游改动 |
|---|---|---|
| `session-query`：最近视图、来源过滤、工作区别名、稳定搜索 | 约 930 行 | 回忆功能；来源过滤读取 header，而不是 `cron-`/`discord-` id 前缀 |
| `llm-pi-ai` 按 provider 的准入队列 | 约 550 行 | 按 provider 的 `maxConcurrentRequests` 与 `queueTimeoutMs` |
| `agent-instructions` 可配置的用户全局候选与按 Session 冻结 | 约 490 行 | 带冻结列表的可配置用户全局文件；人设与记忆依赖它 |
| `sandbox-policy`/`fs-sandbox` 经批准的单次 home 写入；`fs.makeDirectory`/`removeFile` | 约 440 行 | 按调用的修改许可 |
| `tool-present` 可视内容与 `ui-chat.processDisclosure` | 约 440 行 | 内联可视交付 |
| 供 `ui-voice` 听写使用的 `ui-conversation.appendDraft` | 约 60 行 | 输入框追加操作 |
| 研究阶段隐藏（`rp-native-` 前缀）与 `known-event-types.ts` 中的 7 个名称 | 约 30 行 | 隐藏 Session 的 header 标志与插件贡献的已知事件类型 |
| `skill-filesystem` 修改者列表 | 2 行 | 可配置的修改工具名称 |
| `tool-web/conversion` 导出 | 约 240 行 | 导出的 HTML 转 Markdown 转换器 |
| `bundle/web-app` 中的 `--insecure-no-auth`（`webStartup` 注入、connection 行上的 `insecureNoAuth`、`src/startup.ts`）与 `client/connection` | 约 190 行 | 按 Goran 的选择保留；替代方案是上游带长有效期的持久浏览器会话 cookie |
| 小修复：`commands.listForScope`、重复释放、网关心跳与 no-cache 头、session-controller 分页上限、web-fetch 屏蔽主机、附件删除、time-context 星期 | 约 1.2K 行 | 每项一个小的上游改动 |
| 客户端：手机布局、Mermaid/Graphviz 预览、选择器位置、非 loopback 下的设置持久化 | 约 2.8K 行 | 上游客户端 UI 改动 |
| 上游包中适配上述承载的测试（`FileSystem` 修改方法、`HostConnectionService` 认证参数、布局操作、`ui-tool` 的 `details-models.client.spec.ts` 中 `formatSessionSearch` 的工作区参数）、Beardy 消息来源的 V3 到 V4 覆盖，以及 `core/tools` 的 `gen-tool-catalog.spec.ts` 中的 Beardy 工具名 | 少量 | 随各自适配的承载一并移除；当 `scripts/gen-tool-catalog.ts` 把 Beardy 工具包与上游清单分开列出时，这些工具名随之移除 |

## Alternatives considered

**保留修改，并在每次同步时解决冲突。** 否决：0.2.1 同步表明这一成本在每次合并时都会重复，且上游重写组合包行时可能在没有冲突的情况下丢弃 Beardy 行。

**现在就把 Beardy 包迁到独立仓库。** 暂时否决：剩余清单项修改的是没有扩展点的上游代码，且 `research/*` 事件需要插件贡献的已知事件类型，发布版构建才能读取其日志。

**把本地模型检查留在 `llm-pi-ai` 中。** 否决：上游适配器导入了 Beardy 包。`agent/request` waterfall 覆盖所有 Agent 轮次，包括研究阶段与摄像头分类。

## Consequences

所列上游包现在与 `origin/master` 一致，因此后续同步合并它们时不会冲突。代价是依赖 Beardy 接线的行为：

- Agent 轮次之外直接调用 `ctx.llm` 的调用方（例如压缩摘要与会话标题）在已卸载的本地路由上会到达适配器，而不是以 `LOCAL_MODEL_UNLOADED` 失败。
- 卸载不再拒绝已在 `llm-pi-ai` 准入队列中等待的请求。
- 新的 Beardy profile 需要一个列出其组合包的 `package.json`；`dsh --profile beardy` 不再自动创建它。
- 只要启用技能管理或提醒，被裁剪技能的重新加载语句就位于系统提示词中，包括技能目录为空的 Session，而不再位于每条已发布的目录消息里。
- 同一 Session 中工具、调用 id 与原因都相同的并发审批问题，在 Discord 为提示命名时可以互换；答复仍只结算该提示自身的请求，且网关现在需要 `ctx.sessionProjections`。
- 两份副本保持同一算法：webhook 的内联开启流程与 `openUnattendedSession` 一致，training-export 的 `encodeSegment` 与 JSONL 编码器一致（后者由测试固定）。
- 研究行不具备 ui-tool 内部 `ToolRow` 的格式化：没有已保存报告的调用展开后显示纯结果文本。
- `packages/client/` 之外的每个 Beardy 客户端包都在根 `tsconfig.client.json` 中增加一个项目引用。
