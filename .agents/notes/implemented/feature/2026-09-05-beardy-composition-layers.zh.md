# Agent Note: Beardy 组装拆分为机器无关组合包、角色 preset 与个人层

Status: implemented

[English](2026-09-05-beardy-composition-layers.md) | 中文

## 问题

Beardy profile 把三类值混在同一个 patch 文件里。部署数据（`channelId`、`dmUserIds`、网关的 `allowedUserIds` 与 `workspacePath`、morning-brief 任务）在已发布的组合包内点名了一个人的 Discord、一台机器的路径和一个主人的日程，其他用户只能继承或删除它们。角色行为（没人看着时 Beardy 该怎么说话，对比回复私信时该怎么说话）根本没有归属：每个会话——交互式 Web、网关对话、07:00 的 cron 触发——都运行同一个 persona，并且都开着同样的创作工具。而 `memory` 工具挂在组合包层，全局只有一种审批姿态，可是正确的姿态因角色而异：交互式会话能在 Web UI 里回应审批，无人值守任务则必须拒绝写入，而不是卡住或静默落盘。

## 决策

三层，每层只携带一类值。组合包 patch（`packages/bundle/beardy/cordis.patch.yml`）只保留机器无关的组装：provider 选择、`$DSH_HOME` 下的搜索索引路径、带每小时注入节流的 `time-context`，以及按 `DISCORD_BOT_TOKEN` 是否存在门控的三个具备 Discord 能力的行——不携带任何目的地、白名单、时区、工作区或任务数据。被启用却没有 profile 配置的行会在加载时因 schema 失败并点名缺失字段（`$.channelId missing required value`），这是刻意的：半配置的部署停在加载期，而不是按不属于任何人的默认值运行。

角色行为住在 preset 家族里。`beardy` 仍是交互式默认，并接过了 `memory` 行（从组合包移出）；`beardy-unattended` 经 include 接缝由它派生，persona 追加一句话——自行决策、用 `discord_send` 投递、单条不超过 2000 字符——并禁用 `tool-cordis` 与 `skill_manage`、把 `memory` 设为 `requireApproval: true`；`beardy-discord` 追加简洁 Markdown 回复指令与同样的审批姿态，同时保留完整的 standard 工具清单；其消息展示遵循[Discord 交互决策](2026-09-07-discord-native-interactions-and-presentation.zh.md)。由于 `- id:` patch 行会整体替换条目的字段，派生 preset 的 patch 必须携带 `persona` 与 `tool-memory` 配置的完整替换文本；展示文案沿用既有内置 preset 路径（`display.ts` 的键加两侧 client locale 字典）。

个人数据移入 `$DSH_HOME/profiles/beardy/cordis.patch.yml`：tool-discord 目的地行、网关带 `agentPreset: beardy-discord` 的白名单与工作区，以及现在以 `workspace-write` 运行 `beardy-unattended` 的 morning-brief 任务。仓库里的组合包 patch 不含部署信息；私人的 home 文件承载这台机器需要的内容。

standard 能力清单只引入一次。Creator 与 Beardy 先禁用继承的 persona、指令和创作工具行，再提供各自的直接替代行。include patch 会遍历所选文件中的 group，但不会穿透另一层文件 include；直接角色行让 Discord 与无人值守 preset 能替换 persona 和审批配置、禁用创作工具，而不必复制编码工具。随包 Web 组装测试挂载全部三种 Beardy 角色，浏览器启动测试则打开并重新加载 Beardy 工作区会话。

## 考虑过的替代方案

把个人行留在组合包里、用 `!!js process.env.* ?? fallback` 兜底，被否决：看似可配置，实则把一个部署的语义（空格分隔的 id 列表、channel 与 DM 的优先级）编码成随包交付的默认值，而且错误但合法的值会在发送时静默失败而不是在加载时响亮报错。把它们解析成 `undefined` 再指望 profile 覆盖，是同一失败的伪装——schema 必填字段的存在正是为了让"已启用却配置错误"成为加载错误。

一个 preset 加 persona 插件内部条件分支，被否决：persona 没有会话角色输入，角色选择本来就是 preset 接缝该做的事，而按角色复制 include 链恰恰是 `agent-presets/include` 带 patches 这一机制存在的意义。

在组合包层挂 `memory`、再用 preset 作用域的第二次注册去遮蔽它，被否决：同一工具名跨平面两次注册会让解析顺序变成承重结构，而把该行移入 preset 让每个平面只有一个所有者，并让每个派生 preset 各自 patch 自己的配置。

## 后果

现在每个 Beardy 部署都要从自己的 profile patch 提供 Discord 目的地与权限；升级的读者必须一次性补上这些行，否则启用 token 的组装会在加载时失败并点名缺失字段——这是预期行为，组合包 README 的部署小节用环境文件与 systemd unit 覆盖了它。内置 preset 清单增至七个，因此两个新 id 的展示文案同时进入两侧 locale 字典，shipped-root 清单测试钉住新列表。组合包测试现在会启动真实的 Loader 组装（`tests/composition.spec.ts`）来证明各条响亮失败路径，包括那条教训：`dsh-tools` inject 了 `systemPrompt`，所以任何最小启动树都必须先挂载它。在这台机器的 home 文件里，网关保留 `permissionPreset: danger-full-access`，直到 Discord 上出现审批 answerer；届时无人值守与 Discord 会话会换用更窄的权限预设，`memory` 的 `requireApproval` 也从拒绝变成真正的暂存写入。
