# Agent Note: 只读 Beardy 家庭实验室工具

Status: implemented

[English](2026-09-27-homelab-read-only-tool.md) | 中文

## 问题

Beardy 过去通过 `bash` 拼接 `bdy` 命令来回答家庭网络问题。这条路径让模型文本选择动词和标志，包括 Beardy 用于批准变更的 `--yes`。其输出还可能带出 Beardy 密钥文件中的值，而原始 shell 结果既没有行投影，也没有大小上限。

## 决策

`@deepseek-ai/dsh-tool-homelab` 注册一个 `homelab` 工具，其 `action` 枚举映射到九个固定 argv 模板：`hosts list --no-probe`、`discover --no-ping`、`dns --resolvers`、`disk`、带五字段 JSON 模板的 `docker <host> ps --all`、`fw rules`、`router leases`、`net talkers --window 1h --limit 10` 和 `doctor`。每个模板都对照其 Beardy 命令源码核查过：没有一个会调用 `requireApproval()`，且 Beardy 将 `docker ps` 归类为读取。模型唯一可选的 argv 值是 Docker 主机，它受配置 ID 组成的 schema 枚举约束，而这些 ID 在加载时必须存在于 Beardy 清单中。插件从不传递 `--yes`，通过子进程服务运行并显式指定 cwd、截止时间、宽限期和标准输出上限，并将配置的密钥文件作为 `BDY_SECRETS_FILE` 传入。

每次调用都传递 `--json` 和 Beardy 自身的 `--timeout`，后者须短于工具截止时间，以免失效的解析器或主机耗尽时限。结果只保留每个动作文档所列的列，遮盖密钥文件中的值和常见凭据格式，截断单元格，并丢弃末尾的行以符合结果上限。标准错误被丢弃；失败携带固定代码。退出码非零时保留 Beardy 先前输出的行，因为 `disk` 就是这样报告无法访问的主机。密钥文件无法读取时按失败关闭处理。

`allowedAgentPresets` 为必填项，取值为 `any` 或一个预设列表。使用列表时，调用方的当前预设取自预设注册表的 Session 投影，否则回退到创建时的 Session 头；未列出的调用方在进程启动前失败。Beardy bundle 中的条目默认禁用。Goran 的部署为 `beardy` 和 `beardy-discord` 启用它；Mamabear 的会话通道同时被该列表和她的 gateway 工具允许列表排除在外。

## 考虑过的替代方案

**继续让 `bdy` 走 `bash`。** shell 文本可以加入 `--yes`、选择变更动词或打印任意文件，批准与否将只取决于 Beardy 的分类器。

**开放 `ssh`、`logs`、`scan`、`fw loaded`/`states`/`verify` 或 `ct logs`。** 自由形式的远程命令和日志文本可能携带任意私有数据。端口扫描和状态转储的输出没有上限。每一项都需要各自的参数校验和投影。

**只依赖会话通道的工具过滤器来限定预设。** Host 工具对每个预设都可见，除非某个通道加以限制，而且预设可以在 Session 创建后再选择。工具自有的允许列表在过滤器缺失时按失败关闭处理。

## 影响

新增一项观测需要新的枚举值、argv 模板、列清单，以及一次确认对应 Beardy 路径为只读的源码核查。子进程提供方的执行环境中必须有 Beardy 和 23.6 或更高版本的 Node。行投影依赖 Beardy 的 JSON 列名；列被重命名后，在更新列表之前它会从结果中消失。测试使用脚本化的子进程提供方，从不运行 `bdy`；`homelab-hosts` 快照针对一个 fixture 检出目录重放一次 `hosts` 调用。
