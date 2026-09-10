---
description: "配置 Beardy 或其他 Harness 配置档，将研究委派给 Odysseus 工作模型并读取保存的报告。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-odysseus-research

[English](README.md) | 中文

## 概述

`odysseus_research` 启动、检查、读取、列出和取消 Odysseus 研究任务。部署配置选择服务器、凭据引用、端点、模型和研究预算。Odysseus 负责执行任务和保存报告；Harness 记录每次工具调用及其结果。

## 目录

- [配置](#configuration)
- [操作](#operations)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="configuration"></a>
## 配置

Beardy 包含默认禁用的 `tool-odysseus-research` 条目。在个人配置档补丁中填写所有必填值并启用。其他配置档可插入引用此包的条目。Odysseus 必须支持 `research:read` 和 `research:run` 令牌权限；仅接受浏览器会话的研究路由拒绝 bearer 启动请求。通过[凭据提供者](../../credentials/credentials-local/README.zh.md)保存令牌，不要放入模型输入。

```yaml
- id: tool-odysseus-research
  disabled: false
  config:
    baseURL: http://127.0.0.1:7000
    tokenEnv: ODYSSEUS_RESEARCH_TOKEN
    endpointId: worker-4b
    model: Qwen3.5-4B
    disableThinking: true
    maxRounds: 1
    maxTimeSeconds: 60
    requestTimeoutMs: 30000
    maxResponseBytes: 1048576
    pageChars: 16000
```

将示例中的端点和模型标识替换为 Odysseus 注册的值。若 Odysseus 运行于 Docker，其模型端点必须能从容器内部访问工作模型。每次启动都发送配置指定的模型，本插件不执行模型回退。Schemastery 在加载时拒绝缺失字段或超出范围的预算；空白字符串、小数限制以及包含凭据、查询串或片段的 URL 也会被拒绝。

`disableThinking` 默认为 `false`。对于支持 `chat_template_kwargs.enable_thinking` 的工作模型，将其设为 `true` 可让短研究调用的令牌预算用于回答；Odysseus 必须支持 `enable_thinking` 请求字段。

<a id="operations"></a>
## 操作

| 操作 | 输入 | 结果 |
|---|---|---|
| `start` | 非空 `query` | 远程 `id` 和 `status: running` |
| `status` | `id` | 远程状态和进度 |
| `report` | `id` | 通过非消耗式 `result-peek` 读取保存的报告和来源 |
| `list` | 可选的标题搜索 `query` | 活动任务及最多 20 份保存的报告 |
| `cancel` | `id` | 是否请求取消，不表示执行已经停止 |

读取操作返回包含 `text`、`next_offset` 和 `total_chars` 的 JSON。`text` 是 JSON 文档的一页；按顺序拼接所有页面后再解析。将每个非空 `next_offset` 作为 `offset` 传回。偏移量按 Unicode 字符计数。状态和列表可能在读取间变化；分页不会冻结远程响应。报告缺失、令牌被拒绝以及 HTTP 失败都会生成工具错误。重定向被拒绝，请求不会自动重试，截止时间包括响应体读取。

取消 HTTP 调用或卸载插件不会停止远程任务。保留返回的标识；启动请求结果不明确时，先用 `list` 检查再重试；用 `cancel` 停止不再需要的工作。Harness 重启后可凭已记录的标识再次读取报告。不发布运行时不变量伴随模块：此无状态桥接不拥有可独立观察的任务注册表；任务状态由 Odysseus 管理。

<a id="model-experience"></a>
## 模型体验

### 研究工具

#### 模型看到什么

[工具定义](src/index.ts)提供带五种操作的 `odysseus_research`，并说明异步所有权、显式进度检查、报告分页、来源引用以及不可信证据。参数中不包含配置指定的端点、模型或凭据。结果进入普通 Session 工具结果日志。

#### Token 影响

启用期间，每次请求包含一个工具模式。每次读取最多保留 `pageChars` 个 Unicode 有效载荷字符，以及 JSON 包装和转义。报告和来源 URL 在压缩前保留于历史记录中。HTTP 响应体限制在 JSON 解码前约束保留的响应字节数。

#### KV Cache 影响

工具模式在调用间保持稳定。工具结果追加到历史记录；启用或禁用插件会改变模式前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 没有自动完成通知或 Harness 后台任务注册。调用者显式检查状态。即使 Odysseus 将任务标记为完成，研究内容也可能不完整；应检查报告和来源。桥接不验证引用或模型质量。已保存报告列表仅返回前 20 条匹配；缩小标题查询范围以查找较早的报告。变化中的响应可能导致页面偏移。

<a id="dev-note"></a>
### 开发备注

[决策记录](../../../.agents/notes/implemented/feature/2026-09-07-odysseus-research-bridge.zh.md)解释远程任务所有权和显式工作模型选择。Harness 完成监视器需要具备重启恢复和取消语义，才能取代显式读取。
