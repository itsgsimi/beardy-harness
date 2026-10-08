---
description: "在 Web 会话中内联显示 present_visual 交付的视觉快照。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-visuals

[English](README.md) | 中文

## 概述

在会话中内联查看智能体通过 `present_visual` 交付的每个图表、图片或 HTML 原型，以及其标题和结论。可将视觉内容放大到对话框中查看，或下载原始文件。HTML 原型在隔离的框架中运行，无法访问网络或页面。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制和后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

Beardy 包在 `ui-deliverables` 旁以 `ui-visuals` 条目挂载此插件。文件带有已保存 `visual` 的每个 `deliverables/presented` 事件，会在事件位置为每个视觉内容渲染一张卡片，回合进行中和回放时均如此。卡片显示标题、可选说明、图片或原型、“放大查看”和“下载原始文件”。无法解码的视觉内容显示提示，并保留标题和下载链接。

PNG、JPEG、WebP、GIF 和 SVG 以保存的字节渲染为图片。HTML 在 `sandbox="allow-scripts"` 框架中渲染，其内容策略阻止网络请求、嵌套框架、表单和外部资源。

此插件没有配置字段。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节</summary>

浏览器插件通过 `ctx.uiConversation.events` 注册 `presented-visual` 会话定义，并通过带键的 `conversation.chat.node` 插槽注册其视图。定义在构建节点前校验事件的文件声明和 base64 数据，并将节点标记为 `processDisclosure: 'independent'`，使 ui-chat 不把它折叠进回合的过程分组。插件卸载时释放语言字典、定义和插槽条目。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [Present tool](../../deliverables/tool-present/README.zh.md)
- [Deliverables views](../../client/ui-deliverables/README.zh.md)
- [Chat view](../../client/ui-chat/README.zh.md)

<a id="model-experience"></a>
## 模型体验

### 视觉卡片

#### 模型看到的内容

此插件不向模型提供任何内容。模型只看到 `present_visual` 调用及其结果；卡片是已记录的 `deliverables/presented` 事件的浏览器视图。

#### Token 影响

无。插件不添加工具模式、提示词或会话事件。

#### KV 缓存影响

无。请求前缀保持不变。

## 已知限制和后续工作

<a id="known-limitations-and-deferred-work"></a>

当前视觉卡片具有以下限制。

- 卡片依赖 Beardy 在 `tool-present` 和 `ui-chat` 中保留的 `visual` 字段和 `processDisclosure` 值。
- 原型无法加载外部字体、图片或脚本；原型必须内联所需的全部内容。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景</summary>

无需额外说明。

</details>

运行时不变量：未单独发布配套文档；此包的测试覆盖数据校验、框架隔离、解码失败和节点位置。
