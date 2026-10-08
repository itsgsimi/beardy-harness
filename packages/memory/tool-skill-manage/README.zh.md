---
description: "skill_manage 工具、保存为技能的提示，以及被裁剪技能的重新加载指引，与 dsh-tool-skill 一同挂载。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-skill-manage

[English](README.md) | 中文

## 概述

本包让 agent 把可复用的流程保存为技能。`skill_manage` 工具在工作区（`.agents/skills`）中检查、创建、更新和删除扁平技能文件；启用后也可在 Harness home 用户根目录（`$DSH_HOME/skills`）中操作。可选的每 Session 提示会在一次大量使用工具的回合后建议保存流程。技能发现与加载仍由 [`dsh-tool-skill`](../../skill/tool-skill/README.zh.md) 负责；两行需一同挂载。

## 目录

- [配置](#configuration)
- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enableSkillManagement` | `false` | 暴露 `skill_manage` 变更工具；`ctx.fs` 存在后才注册 |
| `enableUserSkillManagement` | `false` | 允许 `skill_manage` 写入每个会话都会加载的 Harness home 用户根目录（`$DSH_HOME/skills`） |
| `requireApproval` | `false` | 任何创建、更新或删除前先询问 approval service；未挂载应答者时拒绝写入 |
| `allowApprovedHomeWrites` | `false` | 同时启用审批与用户作用域管理后，在 `workspace-write` 下授予已获批的精确 home 文件或技能目录 |
| `nudgeAfterToolCalls` | `0` | 单个已完成回合中触发该 Session 唯一一次保存为技能提示的已完成工具结果数；`0` 表示关闭 |
| `skillBodyMaxBytes` | `32768` | `skill_manage` 写入的技能正文 UTF-8 字节上限；末尾换行计入 |

未同时启用 `requireApproval`、`enableSkillManagement` 与 `enableUserSkillManagement` 却设置 `allowApprovedHomeWrites` 时加载失败；负数或小数的 `nudgeAfterToolCalls`，以及小于 1 的 `skillBodyMaxBytes` 同样加载失败。提示功能需要 `ctx.sessionProjections`。

-----

<a id="dev-note"></a>
## 开发备注

`src/manage.ts` 负责草稿检查、审批预览，以及通过 `ctx.fs` 执行的作用域内文件变更；每次变更都携带调用方 Session 的沙箱策略。`src/nudge.ts` 负责 `skillNudge` Session 投影和添加提示的 `agent/pre-step` 监听器。`src/index.ts` 以 `@persistenceAttribution` 声明 `skill-nudge` 消息来源，因此未安装本包的读取方也会保留已记录的提示。

-----

<a id="model-experience"></a>
## 模型体验

### Tool schema

#### What the model sees

生成的 [`skill_manage` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-skill-manage)。`check` 返回 `errors`、`warnings` 以及规范化正文的 UTF-8 `bytes`，不写入也不请求审批。创建和更新在审批前拒绝同样的硬错误，并在审批理由中展示检查结果和有界差异。缺失或过短的 `when_to_use`、单薄的描述或正文以及与目录重叠均为警告。变更返回受影响的路径和状态；拒绝时说明原因，包括正文超过 `skillBodyMaxBytes`、用户作用域已关闭、审批被拒或不可用、生命周期不匹配、目标不安全、缺少工作区 cwd 或路径越界。

#### Token effect

工具可见的每次请求都有固定 schema 成本；每次调用及结果作为工具历史记录。

#### KV Cache effect

工具定义和可见性不变时前缀保持稳定。

### System prompt section

#### What the model sees

启用管理或提示时，`tool:skill-manage` 段（顺序 2360）加入：

##### 被裁剪技能重新加载指引

```markdown
If a previously loaded skill result contains the marker [... tool result middle pruned ...], its steps are incomplete: reload that skill by name before acting on it.
```

#### Token effect

每次请求一句固定文本。

#### KV Cache effect

每个组合内保持静态，因此位于可复用前缀之内。

### Skill nudge

#### What the model sees

某个已完成回合产生至少 `nudgeAfterToolCalls` 个工具结果、且模型未加载技能、用户也未调用技能时，下一次请求会获得一条来源类型为 `skill-nudge` 的 user 角色提示：``The last turn used <n> tool calls. If its procedure is reusable, save it as a skill with `skill_manage`; otherwise ignore this.``。一个 Session 在恢复后也最多收到一次；subagent Session 不会收到。

#### Token effect

每个 Session 最多一条保留的短消息。

#### KV Cache effect

仅追加；提示位于可复用前缀之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅限扁平文件** — `skill_manage` 每个技能只写一个 `<name>.md`，不管理目录技能及其资源。
- **变更工具名保留在 `dsh-skill-filesystem` 中** — 文件系统提供方的变更 actor 列表写有 `skill_manage`，重命名工具时需同步更新该列表。
- **Invariant companion** — 不发布运行时不变量伴随模块，因为本包自身唯一的 Session 记录是 `skill-nudge` 提示，其投影从同一日志读回；工具调用由工具注册表记录，因此没有可分歧的独立观测供 `./invariant` 检查。
