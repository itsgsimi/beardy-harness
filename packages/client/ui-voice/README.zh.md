---
description: "本地语音输入的配置、使用方式与边界。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-voice

[English](README.md) | 中文

## 概述

通过会话输入框的麦克风按钮听写消息。停止录音后，转写文字追加到现有草稿，再按正常流程检查并发送。取消操作会丢弃录音。主机提供语音转写时显示此控件，其样式与周围工具栏一致。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制和后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

web-app 包在 `ui-conversation` 旁挂载此插件。启用主机的[语音提供程序](../../speech/speech-whisper/README.zh.md)后即可显示麦克风。请通过 HTTPS 或 localhost 打开 Harness，并在开始录音时授予麦克风权限。

点击麦克风、说话，再点击停止。转写文字会追加到草稿，而不会替换原有文字或附件引用。取消会停止录音或转写，不插入文字。若其他交互临时占用输入框，可在该交互结束后点击插入转写。

此插件没有配置字段。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节</summary>

浏览器插件通过插槽注册表向 `conversation.input.right` 添加控件。MediaRecorder 生成有界录音，控件将其上传到主机，再通过会话输入接口追加文字。取消或卸载时会释放音轨、HTTP 请求、语言注册和插槽内容。控件不会执行发送操作。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [Composer](../../client/ui-conversation/README.zh.md)
- [Discord gateway](../../discord/discord-gateway/README.zh.md)
- [Web client](../../../docs/subsystems/web-client.zh.md)

<a id="model-experience"></a>
## 模型体验

### 用户转写文本

#### 模型看到的内容

用户发送草稿后，经过检查的转写文字成为普通 `user/message` 文本。录音状态、错误和取消操作不会进入模型上下文。

#### Token 影响

转写文字随用户消息长度增加输入 token；插件不添加工具模式或固定提示词。

#### KV 缓存影响

转写在普通用户消息边界追加，不改变已有的请求前缀。

## 已知限制和后续工作

<a id="known-limitations-and-deferred-work"></a>

当前语音功能具有以下限制。

- 浏览器录音需要 HTTPS 或 localhost，以及兼容的 MediaRecorder 实现。
- 录音由用户主动启动并有时长限制，不支持持续监听或自动发送。
- 离开输入框会取消正在进行的录音。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景</summary>

无需额外说明。

</details>

运行时不变量：未单独发布配套文档；此包的测试覆盖有界处理、取消和生命周期。
