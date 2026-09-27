---
description: "选择要写入进程日志的 Cordis 消息，规范化生命周期行，并在输出前脱敏和限制长度。"
kind: "package-reference"
---

# @deepseek-ai/dsh-log-exporter

[English](README.md) | 中文

## 概述

将选定的 Cordis 日志按每条一行导出。部署可以选择严重级别、精确 logger 名称、消息前缀，以及生命周期消息的稳定替换文本。写入 stdout 前依次应用脱敏模式和行长度限制。Beardy 使用此包记录网关生命周期、cron 结果以及所有警告和错误。

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

在产生日志的插件之后挂载 Host 条目。导出器向 Cordis logger 注册，并随插件 fiber 解除挂载。[Beardy 组合包](../../bundle/beardy/README.zh.md)展示网关所属的 profile 层；部署专用的模式应放在个人 patch 中。

```yaml
- id: journal
  name: '@deepseek-ai/dsh-log-exporter'
  config:
    levels: [error, warn, info]
    messagePrefixes: ['dsh-cron:']
    maxLineLength: 2000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `levels` | `[error, warn, info]` | 可导出的严重级别。启用的警告和错误不受其他筛选条件限制。 |
| `loggerNames` | `[]` | 在 info 或 debug 级别纳入的精确 logger 名称。 |
| `messagePrefixes` | `[]` | 在 info 或 debug 级别纳入的字符串前缀。 |
| `lifecycleLines` | `[]` | 精确匹配或前缀及可选后缀匹配，映射为稳定输出。 |
| `redactionPatterns` | `[]` | 按顺序执行的全局正则替换。 |
| `maxLineLength` | `2000` | 每行最多写入的字符数，截断时包含省略号。 |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-log-exporter)列出各字段。无效正则、空筛选项、含糊的生命周期匹配器以及非整数限制在激活时失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

导出器接收结构化 Cordis logger 消息。它将所有选中的警告和错误连同级别及 logger 名称一起写入。对于 info 和 debug，它先选择匹配生命周期映射或消息前缀的字符串；如果两者均未匹配，精确 logger 名称会导出整条记录。每个候选内容成为一行；换行符变为空格，脱敏模式按顺序运行，最后应用长度限制。此包不添加 Session 事件或模型输入。导出器注册没有独立的状态投影，因此不发布 invariant 伴随模块。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [应用启动](../app-boot/README.zh.md)——Host 启动和 logger 生命周期。
- [Beardy 组合包](../../bundle/beardy/README.zh.md)——提供网关的 profile 层。

-----

<a id="model-experience"></a>
## 模型体验

没有直接模型内容，因为导出器只改变进程日志。

#### KV Cache 影响

导出器不添加模型输入，也不改变缓存。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 脱敏依赖配置的模式；部署需要匹配自身的凭据格式。
- 日志行输出到进程本地 stdout，不属于 Session 事件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作记录——点击展开</summary>

无。

</details>
