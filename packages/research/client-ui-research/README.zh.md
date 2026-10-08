---
description: "在 Web 会话中打开已保存的深度研究报告，并在设置中选择研究工作模型。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-research

[English](README.md) | 中文

## 概述

在会话行中打开 `deep_research` 或 `odysseus_research` 调用保存的完整报告，连同编号来源一起阅读，并下载为 Markdown。设置 → 插件新增“深度研究”标签页，用于为当前配置中的新研究任务选择工作模型。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制和后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

Beardy 包以 `ui-research` 条目挂载此插件。每个研究调用显示其状态，以及查询、运行 ID 或操作。若已完成调用的结果元数据带有保存的报告，行内显示“打开研究报告”；对话框渲染报告，只为 `http:` 和 `https:` 来源生成链接，并提供以来源列表结尾的 Markdown 下载。其他调用展开后显示结果文本。

“深度研究”设置标签页读写配置中的 `odysseus-research` 条目：列出默认工作模型和已配置的 `workers`，保存时只写入 `selectedWorker`。现有任务保留原工作模型。配置中没有研究条目时，标签页会给出提示。

此插件没有配置字段。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节</summary>

浏览器插件为每个研究工具名注册一个带键的 `tool.call.toolview` 条目，并注册一个 `settings.plugins.tab` 条目。行组件从已完成调用读取 `meta.researchArtifact`，拒绝格式错误的元数据。下载 URL 在对话框打开时创建，关闭时撤销。设置标签页跟随共享的 `configForms` 条目，因此其他客户端修改配置后选择器会同步更新。插件卸载时释放语言字典、插槽条目和表单订阅。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [Research service](../research/README.zh.md)
- [Native research tool](../tool-research/README.zh.md)
- [Tool call views](../../client/ui-tool/README.zh.md)
- [Plugins settings section](../../client/ui-settings-plugins/README.zh.md)

<a id="model-experience"></a>
## 模型体验

### 报告对话框

#### 模型看到的内容

此插件不向模型提供任何内容。模型只收到 `deep_research` 或 `odysseus_research` 的结果文本；报告对话框和设置标签页都是浏览器视图。

#### Token 影响

无。插件不添加工具模式、提示词或会话事件。

#### KV 缓存影响

无。请求前缀保持不变。

## 已知限制和后续工作

<a id="known-limitations-and-deferred-work"></a>

当前研究视图具有以下限制。

- 报告对话框需要调用结果元数据中带有报告；工具开始保存报告之前记录的调用只显示结果文本。
- 设置标签页只编辑 `odysseus-research` 条目；原生 `research-local` 的模型设置仍在配置文件中。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景</summary>

无需额外说明。

</details>

运行时不变量：未单独发布配套文档；此包的测试覆盖元数据校验、来源链接过滤、下载 URL 释放和设置表单写入。
