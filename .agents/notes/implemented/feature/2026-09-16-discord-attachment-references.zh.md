# Agent Note: Discord 附件引用保留给 agent

Status: implemented

[English](2026-09-16-discord-attachment-references.md) | 中文

## Problem

每周成绩上传可能只有截图。丢弃附件元数据会使消息变成空内容，导致 agent 无法查看或保存证据。

## Decision

[Discord 网关](../../../../packages/discord/discord-gateway/README.zh.md)将 JSON 编码的附件引用附加到已准入的消息正文。引用包含文件名、URL、媒体类型和字节数，并明确标记为不可信数据。仅含附件的消息使用普通会话路径，保留 Discord 来源信息。现有输入长度上限约束最终传给模型的文本。

网关不获取文件。agent 选择的工具负责下载限制、文件校验、保存和图像解读。带签名的附件 URL 可能过期，因此需要持久保存的流程会及时归档文件。

## Alternatives considered

**由网关下载文件：** 会给传输层增加网络、文件系统、清理和图像解码职责。传递引用可将这些职责留给使用文件的工具。

**忽略仅含图像的消息：** 会丢失有效的用户请求，使基于截图的流程无法工作。

## Consequences

JSON 编码将文件名保留为数据，而不是 Markdown 结构。元数据既不能证明文件内容，也不是可信指令。测试覆盖格式错误的条目、图像说明、通过真实 Loader 路由仅含附件的消息，以及记录模型可见引用的无密钥[会话快照](../../../../snapshots/session/discord-attachments/snapshot.yml)。现有频道和用户允许列表继续控制准入。
