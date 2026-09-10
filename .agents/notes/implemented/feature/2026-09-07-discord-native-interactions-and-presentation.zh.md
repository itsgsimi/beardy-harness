# Agent Note：Discord 原生交互与持久消息展示

Status: implemented

[English](2026-09-07-discord-native-interactions-and-presentation.md) | 中文

## Problem

Discord 应用命令会在注册它们的运行时停止后继续存在。只接受斜杠前缀聊天文本的 bot 会留下其他运行时的菜单，却无法回答其交互。纯文本命令响应与审批提示也隐藏了 Discord 用户期望的对话控件，而直接拆分原始文本可能破坏围栏代码，并使 Markdown 表格难以阅读。

## Decision

启用 `nativeCommands` 时，网关拥有应用的全局命令目录。它从配置预设的 standing 注册表提取命令，加入 `/help`、`/new`、`/status`、`/stop`，并排除由其他 UI 执行的命令。每次新的 Gateway READY 与注册表变更后，网关将全局目录与配置的命令比较，仅在有差异时批量替换。服务器专属注册仍单独管理。原生与文本命令共享执行、权限与对话生命周期；发布菜单不会创建 Agent 或 Session。

原生调用验证应用、用户与频道，在执行工作前确认，并私密返回结果。交互 id 使用有界去重保留；响应 token 只留在内存中，永不进入持久发件箱。审批按钮与选项菜单还匹配待决请求标识与提示消息。请求结束后移除控件；过时或重复点击无法回答后来的请求。超过 Discord 25 个选项限制的问题与自由文本问题保留文本作答。

[共享 Discord 格式化器](../../../../packages/discord/tool-discord/README.zh.md)保留原生 Markdown，并使用持续维护的 mdast GFM 解析器识别表格与代码。表格转为带标签的项目组；超长围栏代码在保留语言与缩进的情况下关闭并重新打开，包装文本也计入 Discord 的 UTF-16 上限。命令与生命周期卡片是已有结果的纯投影。状态表情与正在输入提示显示活动，不流式发送内部推理或工具跟踪。

存储域版本 3 在旧字符串分条之外接受有界富消息体。本域的默认单文件布局拒绝旧单元版本；`compatibleVersions` 只适用于逐记录存储，无法升级此文件。操作者必须停止网关，用当前 schema 验证全部持久记录，保留逐字节一致的备份，再原子地仅将单元版本改为 3 后重新打开。无效记录会阻止该升级。[持久投递归属方](2026-09-07-durable-personal-agent-delivery.zh.md)在发送前保存完整投递，并为已接受分条记录检查点；重试原样发送保存的消息体。校验覆盖 embed 文本总量、组件行、选项数量与组件标识唯一性。原生响应 token 与待决等待是临时的，因为它们无法提供相同的重启保证。

已审阅的 [Hermes Discord 适配器](https://github.com/NousResearch/hermes-agent/blob/79445a496c86a19332ad786494b8384d2167e2d0/plugins/platforms/discord/adapter.py)提供了有用先例：原生命令委托共享执行，表格采用带标签的行，提示控件验证回答者与有效期。DSH 使用自己的注册表、作用域请求 waterfall 与持久投递记录。[对话连续性](2026-09-05-discord-durable-conversations.zh.md)和[审批生命周期归属](2026-09-05-discord-approval-answerers.zh.md)仍分别拥有独立决策；本决策替代其中仅文本展示的假设。

预设继承与部署分层仍由 [Beardy 组合层](2026-09-05-beardy-composition-layers.zh.md)决策负责；Discord persona 使用简洁 Markdown，并将消息拆分交给传输层。

## Alternatives considered

只清除过时命令而不处理原生交互，会让用户依赖难以发现的文本命令。注册第二套命令处理器会复制权限与取消行为，因此原生适配器委托现有注册表路径。

手写 Markdown 解析器会重复仓库中持续维护的依赖已处理的语法。剥除所有 Markdown 的渲染器会丢失有用链接与代码；格式化器只转换不受支持的表格以及超长代码块的拆分处。

在投递重试时重建富文本输出，可能在升级后改变排队文本或控件。持久保存完整格式化消息体，使重试行为不依赖当前渲染器，同时保留既有的至少一次投递限制。

## Consequences

一个运行时必须同时拥有 bot 的命令目录与 Gateway 连接。Discord 必须通过 Gateway 交付交互，不能配置向外发送交互的 Interactions Endpoint URL。格式变更需要解析器、协议限制与持久化测试；原生命令和提示变更需要授权、过期、去重与取消覆盖。录制会话快照通过发行 profile 验证私信回复与原生控件，无需 Discord 凭据。可配置的队列、重试、响应与并发限制避免单个对话产生无界投递工作。
