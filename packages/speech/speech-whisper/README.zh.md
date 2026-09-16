---
description: "本地语音输入的配置、使用方式与边界。"
kind: "package-reference"
---

# @deepseek-ai/dsh-speech-whisper

[English](README.md) | 中文

## 概述

通过本地 whisper.cpp 服务将浏览器录音和音频文件转为文字。浏览器听写会保留在草稿中，等待用户发送。Discord 语音消息和标准音频附件在转写后进入普通用户消息流程。FFmpeg 在 Harness 主机运行，并受字节数、时长、并发数和超时限制。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制和后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

在主机配置中将此插件与子进程提供程序一起挂载。通过配置补丁启用内置的 `speech-whisper` 行。端点必须接受 whisper.cpp 的 multipart `/inference` 协议。在 Harness 主机安装 FFmpeg，并将推理端点保持为私有。

```yaml
- id: speech-whisper
  disabled: false
  config:
    endpoint: http://127.0.0.1:8178/inference
    ffmpegPath: ffmpeg
    maxAudioBytes: 16777216
    maxDurationSeconds: 180
    timeoutMs: 120000
    maxConcurrent: 2
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `endpoint` | 必填 | 本地 whisper.cpp 推理 URL |
| `ffmpegPath` | 必填 | 音频解码程序 |
| `maxAudioBytes` | 必填 | 编码上传大小上限 |
| `maxDurationSeconds` | 必填 | 解码录音时长上限 |
| `timeoutMs` | 必填 | 整个转写操作的超时 |
| `maxConcurrent` | 必填 | 同时转写的请求数上限 |

基础配置提供上述值，但默认禁用语音。

浏览器通过需要身份验证的 `/api/speech` 路由上传音频。Discord 音频沿用网关的准入规则。标准音频文件附件在用户消息提交前完成转写。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节</summary>

提供程序通过仅允许管道协议的 FFmpeg 将单条音轨解码为有界的 16 kHz 单声道 PCM，再封装为 WAV 并发送给 whisper.cpp。取消请求或卸载插件会终止子进程并等待正在进行的工作结束。可选的附件消费者在持久文件引用旁追加转写文本；Discord 消费者验证 CDN URL 并保留消息来源。

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

音频附件在同一用户消息中添加 `Voice transcript for <filename>:` 和识别文字。Discord 添加 `Voice transcript:` 并保留普通消息来源。浏览器录音成为普通草稿文字，由用户决定何时发送。

#### Token 影响

转写文字随用户消息长度增加输入 token；插件不添加工具模式或固定提示词。

#### KV 缓存影响

转写在普通用户消息边界追加，不改变已有的请求前缀。

## 已知限制和后续工作

<a id="known-limitations-and-deferred-work"></a>

当前语音功能具有以下限制。

- 需要 FFmpeg 和兼容的推理服务器。
- 语言支持和识别质量取决于模型；当前部署使用英语 `base.en`。
- 上传音频通过常见文件扩展名识别。暂不支持实时通话或语音回复。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景</summary>

无需额外说明。

</details>

运行时不变量：未单独发布配套文档；此包的测试覆盖有界处理、取消和生命周期。
