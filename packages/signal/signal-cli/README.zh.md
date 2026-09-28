---
description: "ctx.signal 的 signal-cli 提供方：经持久发件箱发送 JSON-RPC 请求，并从守护进程的事件流接收消息。"
kind: "package-reference"
---

# @deepseek-ai/dsh-signal-cli

[English](README.md) | 中文

## 概述

通过同一主机上的 [signal-cli](https://github.com/AsamK/signal-cli) 守护进程收发 Signal 消息。每条被接受的消息先存入持久发件箱再发送，按目的地顺序发送，并在守护进程不可用时以倍增延迟重试。守护进程事件流中收到的数据消息以 `signal/message` 发布。守护进程不可达时，提供方从不让主机停止。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

先用 signal-cli 注册一个号码，然后在回环地址上为该账户运行守护进程，例如 `signal-cli -a <number> daemon --http 127.0.0.1:8820`。守护进程没有身份验证，因此 `baseUrl` 只接受带端口且无路径的 `http://127.0.0.1`、`http://localhost` 或 `http://[::1]`。以 `-a` 启动的守护进程只服务一个账户，配置中无需 `account`，电话号码因此不会出现在配置文件中。

| Config | Meaning |
|---|---|
| `baseUrl` | 守护进程根地址，例如 `http://127.0.0.1:8820`；必填 |
| `account` | 每个请求携带的 E.164 账户，仅用于服务多个账户的守护进程 |
| `requestTimeoutMs` | 单个 HTTP 请求的最长等待（默认 15000） |
| `receive` | 订阅事件流并发布 `signal/message`（默认 true） |
| `reconnectDelayMs`, `maxReconnectDelayMs` | 事件流重连延迟，默认从 1000 倍增到 60000 |
| `maxMessageChars` | 单条消息的最长文本；更长的投递会被拆分（默认 2000） |
| `outboxMaxPending` | `send` 拒绝前允许的未完成投递数（默认 200） |
| `outboxMaxChars` | 单次投递的最长文本（默认 20000） |
| `outboxRetryMs`, `outboxMaxRetryMs` | 发送重试延迟，默认从 5000 倍增到 600000 |
| `outboxMaxAttempts` | 放弃投递前允许的失败次数（默认 30） |
| `outboxMaxReceipts` | 为识别重复 id 保留的已完成投递 id 数（默认 1000） |

启动时提供方检查 `GET /api/v1/check` 并记录一行：

- `signal-cli: connected as +*********12`，级别 `info`，账户仅保留末两位；
- `signal-cli: connected to http://127.0.0.1:8820; the daemon did not report its account`，级别 `info`，表示守护进程有应答但未给出唯一账户；
- `signal-cli: daemon at http://127.0.0.1:8820 is unreachable (<cause>); deliveries stay queued and retry until it answers`，级别 `error`。

设置了 `account` 时，`signal-cli: account +*********99 is not registered with the daemon; sends will fail`（级别 `error`）报告守护进程未列出的账户。重试的发送记录 `signal-cli: delivery <id> stays queued; retrying in <ms> ms: <cause>`（级别 `warn`），被放弃的投递记录 `signal-cli: delivery <id> abandoned after <reason>`（级别 `error`）。这些日志引用的守护进程错误文本会遮蔽所有电话号码。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

`send` 把文本拆成不超过 `maxMessageChars` 的片段，优先在段落、行和单词处断开，并在返回前以投递 id 为键向 `signal_cli` 存储域的 `outbox` 表写入一条记录。只要记录或回执仍在，重复的 id 就返回 `duplicate`。发件箱按接受顺序发送记录；失败的记录会阻塞同一目标的后续记录直到其重试时间，其他目标继续发送。每个被确认的片段都会推进持久游标，因此重试从未发送的片段继续。已存储的图片在其片段发送时经 `ctx.attachments` 读取，并以 `data:<type>;filename=<name>;base64,<bytes>` 附件交给 signal-cli；图片不可读或没有附件存储时，发送纯文本消息并记录警告。

每个片段以一个 JSON-RPC `send` 请求发往 `POST /api/v1/rpc`，携带 `groupId` 或 `recipient`、去掉 `**bold**` 标记的文本，以及 `start:length:BOLD` 形式的 `textStyle` 范围。提供方在进程边界校验每个响应，不使用 JSON-RPC 批量请求。代码为 -32700、-32600、-32601、-32602 或 -1 的 JSON-RPC 错误，或所有接收方均未注册的发送，属于永久失败，投递立即被放弃；其他失败会重试直到 `outboxMaxAttempts`。至少一个接收方成功的发送视为已投递。被放弃的投递保留带原因的回执，超过 `outboxMaxReceipts` 的回执按最旧优先删除。

接收器保持 `GET /api/v1/events` 打开，按其读取的信封字段校验每个 Server-Sent Event，并发布带文本或附件的数据消息；回执、输入状态、同步和仅含表情回应的信封被忽略。事件数据可以是接收通知的 params，也可以是整条通知。事件流在出错或结束后重连，延迟倍增到 `maxReconnectDelayMs`，连接建立后重置。启动时的账户来自 `listAccounts`，单账户守护进程可能不提供该方法。释放时中止请求和事件流，等待进行中的发送，并关闭存储域。发件箱记录是唯一的状态且由存储域校验，因此不发布不变量配套模块。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Signal 子系统](../../../docs/subsystems/signal.zh.md) — 投递目标、发件箱和收到的消息。
- [signal-cli JSON-RPC](https://github.com/AsamK/signal-cli/wiki/JSON-RPC-service) — 守护进程的方法和 HTTP 端点。

-----

<a id="model-experience"></a>
## 模型体验

### signal-cli 提供方

#### 模型看到的内容

提供方不注册工具、模式或提示词；本版本中没有使用方把它的 `signal/message` 载荷展示给模型。

#### Token 影响

提供方不增加模型 token。

#### KV Cache 影响

提供方不影响请求缓存。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 投递至少一次：守护进程已发送但检查点未写入的片段，会在重启后再次发送。
- 只有 `**bold**` 被转换为 Signal 样式；定时运行文本中的其他 Markdown 以原字符到达。
- 守护进程错误码按 signal-cli 文档中的代码分类；以后新增的代码会重试直到 `outboxMaxAttempts`。
- 收到的附件只描述，不下载。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
