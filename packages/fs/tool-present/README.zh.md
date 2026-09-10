---
description: "通过 present 声明交付可访问的文件；配置、Session 归属与源文件打开。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-present

[English](README.md) | 中文

## 概述

使用 `present` 声明交付Session 文件系统可访问的最终文件，包括通过 shell 命令创建的文件。用户使用默认应用打开当前源文件。工具记录路径和可选说明，不复制文件内容。`present_visual` 可在聊天中展示图表、截图、动画、示意图和交互原型，并保留原始字节。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

`standard`、`ptc` 与 `cordis` Agent preset 挂载本插件。创建文件后，以 `files: [{ path, description? }]` 调用 `present`。文件必须是 Session 文件系统可访问的普通文件。相对路径按 Session 工作目录解析；绝对路径可以指向工作区外的文件，包括 `/tmp` 或 Downloads。文件缺失、为目录、最终路径为符号链接或提供方拒绝访问时，调用失败。Shell 沙箱私有 `/tmp` 中的文件需要先写入 Session 文件系统可访问的位置。

工作过程中，以 `{ path, title, description }` 调用 `present_visual`，展示已保存的视觉内容。标题同时作为替代文本，说明在视觉内容旁提供发现。支持按扩展名识别 PNG、JPEG、WebP、GIF、SVG 和 UTF-8 HTML。HTML 必须内嵌脚本、样式及资源。工具为用户展示字节，不声称已检查内容，也不要求模型支持图像输入。

在 Agent 的 Cordis 组合中挂载，并提供 `tools`、`fs` 和 `turnBoundary` Session 投影：

```yaml
- name: '@deepseek-ai/dsh-tool-present'
  config:
    maxFiles: 8
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxFiles` | `8` | 每次调用的最大文件数，为正整数 |
| `maxVisualBytes` | `8388608` | 完整视觉交付序列化后的字节上限，包括 base64、标题、说明及声明字段 |

挂载时校验两项交付上限。工具要求 Agent Session 具有工作区和尚未结束的轮次。交付归调用方 Session 所有；父 Session 如需声明交付子 Agent 创建的文件，必须自行调用 `present`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`present` 通过配置的文件系统提供方解析路径，检查普通文件元数据，不读取内容。`present_visual` 通过同一提供方读取有界字节，并在交付事件中保存不可变快照；完整交付超限时，在发布前失败。成功的最终 `tools/result` 通知追加 `deliverables/presented`，嵌套调用也适用。外层程序随后失败不会撤销已完成的声明。被阻止的结果不发布声明。每个插件实例只记录其实际执行的调用；同名作用域工具不能通过其他实例发布交付。

纯 `./types` 入口声明 `PresentedFile` 与 Session 事件，不导入 Host 运行时代码。Web 消费方在展示或打开文件前校验持久声明。事件不保存 Session ID，因此 fork 历史中的相对路径按当前查看的 Session 工作区解析。

**运行时不变式：** 不发布伴生入口。工具与事件注册归 effect 所有，Session 日志拥有文件声明；插件不维护独立的文件内容存储。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [文件系统子系统](../../../docs/subsystems/filesystem.zh.md)——提供方路径与错误。
- [Web 交付](../../client/ui-deliverables/README.zh.md)——源文件打开与卡片。
- [交付决策](../../../.agents/notes/implemented/feature/2026-09-08-present-workspace-source-files.zh.md)——Session 归属与读取端必须识别的事件。

<a id="model-experience"></a>
## 模型体验

### present

#### 模型看到的内容

[present schema](../../../docs/tool-catalog.zh.md#present)要求已有且可访问的文件：“Declare existing files accessible through the Session filesystem as final deliverables. When a file you create or update is an output the user asked to receive, you must call present after writing it and before your final response, including files created through Bash or code execution. Mentioning its path in your reply does not replace this call. The files must already exist. The user opens the current source files; their contents are not copied or preserved.” 每个文件的结果为 `Presented <path>`；程序结果和持久事件包含路径及可选说明。

#### Token 影响

每个挂载的 Agent 获得两个工具 schema，每次交付生成一条回执。`present_visual` 返回 `Presented visual: <title> (<path>)`；其 schema 要求在数据说明旁展示图表，并在浏览器测试中使用视觉内容。文件字节保留在仅供展示的交付事件中，不进入模型消息或程序返回值。

#### KV Cache 影响

工具 schema 在挂载期间保持静态。交付结果文本扩展对话，不重写提示词前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 元数据和 Host 路径检查无法原子性地阻止桌面应用打开文件前发生的路径替换。
- 编辑会改变打开的内容。源文件删除或移动后，无法通过原声明打开。
- 普通 `present` 声明不保留字节。视觉快照随 Session 日志传输并增加日志大小；可配置的单次调用上限不限制整个 Session 的总量。
- 扩展名选择渲染方式；浏览器报告无法解码的图片。HTML 和 SVG 要求有效 UTF-8。不支持外部原型资源、依赖服务端的应用或视频。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
