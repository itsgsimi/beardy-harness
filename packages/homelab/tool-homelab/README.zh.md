---
description: "通过一个有界只读模型工具读取 Beardy 的主机清单、网络、DNS、磁盘、Docker、防火墙、路由器和诊断信息。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-homelab

[English](README.md) | 中文

## 概述

使用 `homelab` 通过 Beardy CLI 查看选定的家庭网络信息。部署方选择可执行文件、密钥文件、Docker 主机 ID、可调用该工具的 agent 预设，以及时限和输出上限。模型只指定一项观测并收到投影后的行；命令文本、标志和 `--yes` 都不是模型输入。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将工具与 `dsh-tools`、Session 投影和一个子进程提供方一同挂载。Beardy bundle 默认禁用此行；个人补丁先提供路径和允许列表，再启用它。

```yaml
- id: tool-homelab
  name: '@deepseek-ai/dsh-tool-homelab'
  config:
    bdyPath: /home/goran/beardy/bin/bdy
    secretsPath: /home/goran/.config/beardy/secrets.env
    allowedHosts: [mini, pihole]
    allowedAgentPresets: [beardy, beardy-discord]
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `bdyPath` | 必填 | Beardy 检出目录内 `bin/bdy` 的绝对路径；该目录须包含 `src/cli.ts` 和 `inventory/hosts.json`。 |
| `secretsPath` | 必填 | Beardy 密钥文件，以 `BDY_SECRETS_FILE` 传给 Beardy；其中的值会从结果中遮盖。 |
| `allowedHosts` | 必填 | `docker_status` 可指定的清单 ID；列表为空时移除该动作。 |
| `allowedAgentPresets` | 必填 | `any`，或其 Session 可调用此工具的 agent 预设。当前预设取自预设注册表的 Session 投影，否则取 Session 头；没有预设的 Session 只匹配 `any`。 |
| `timeoutMs` | `30000` | 单次调用的实际时限，1000–300000 毫秒。 |
| `bdyTimeoutSeconds` | `10` | Beardy 自身每项操作的 `--timeout`，1–120 秒，须短于 `timeoutMs`。 |
| `graceMs` | `1000` | 终止宽限期，1–30000 毫秒。 |
| `maxStdoutBytes` | `262144` | 收集的标准输出上限，4096–4194304 字节。 |
| `maxResultBytes` | `16384` | 序列化结果上限，1024–65536 字节。 |
| `maxCellChars` | `256` | 遮盖后每个单元格保留的字符数，16–4096。 |

路径不在 Beardy 检出目录内、`bin/bdy` 不可执行、主机 ID 不在清单中或某项上限超出范围时，加载失败。[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-homelab)列出接受的字段。

| 动作 | 跟在 `bdy --json --timeout <s>` 之后的 Beardy 命令 |
|---|---|
| `hosts` | `hosts list --no-probe` |
| `discover` | `discover --no-ping` |
| `dns` | `dns --resolvers` |
| `disk` | `disk` |
| `docker_status` | `docker <host> ps --all --format <五字段 JSON 模板>` |
| `firewall_rules` | `fw rules` |
| `router_leases` | `router leases` |
| `net_top` | `net talkers --window 1h --limit 10` |
| `doctor` | `doctor` |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

除非 `allowedAgentPresets` 为 `any`，工具先检查调用方 Session 当前的 agent 预设。随后它从上表选出一条 argv，通过子进程服务在 Beardy 检出目录中启动它。每条命令都是 Beardy 读取操作：没有一条调用 `requireApproval()`，Beardy 也将 `docker ps` 归类为读取。工具解析 Beardy 的 JSON 行或 Docker JSON 行，只保留每个动作文档所列的列。它遮盖密钥文件中的值、bearer token、凭据赋值和 URL 中的凭据，截断单元格，并丢弃末尾的行以符合 `maxResultBytes`。退出码非零时保留 Beardy 先前输出的行，例如 `disk` 中无法访问的主机。标准错误被丢弃，失败使用固定代码。密钥文件无法读取时，调用按失败关闭处理。插件除注册外不拥有任何状态，因此不发布 invariant companion。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [子进程服务](../../subprocess/subprocess/README.zh.md)——有界进程执行。
- [Beardy bundle](../../bundle/beardy/README.zh.md)——默认禁用的行。

-----

<a id="model-experience"></a>
## 模型体验

### 家庭网络请求

#### 模型看到什么

模型看到一个 `homelab` 工具，带必填的 `action`；配置了 Docker 主机时，还有供 `docker_status` 使用的 `host` 枚举。结果包含 `action`、`status`（`ok`、`error` 或 `timeout`）、投影后的 `rows`、`omittedRows`，失败时另有固定 `code` 和可选 `exitCode`。无效输入和不在 `allowedAgentPresets` 中的调用方在进程启动前失败。

#### Token 影响

挂载期间每个请求包含一个 schema。每次调用向 Session 历史添加一个不超过 `maxResultBytes` 的结果或一个工具错误。

#### KV Cache 影响

已挂载 profile 的 schema 保持稳定；每个结果延长历史。

## 已知限制与待办事项

<a id="known-limitations-and-deferred-work"></a>

- 子进程提供方的执行环境中必须安装 Beardy 和版本不低于 23.6 的 Node 运行时。
- 标准输出超过 `maxStdoutBytes` 时不返回任何行，因为不完整的 JSON 不可信。
- 遮盖覆盖密钥文件中至少四个字符的值和常见凭据格式；不要把其他私有数据写入清单标签。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护人员工作上下文——点击展开</summary>

无。

</details>
