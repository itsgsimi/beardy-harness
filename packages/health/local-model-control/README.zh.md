---
description: "让获准的人类预设加载或卸载固定的本地模型后端，并查看持久化的主动卸载状态。"
kind: "package-reference"
---

# @deepseek-ai/dsh-local-model-control

[English](README.md) | 中文

## 概述

使用 `/models` 查看、加载或卸载已配置的 Docker 容器与远端 halorun 配置。`/gaming on` 等具名分组命令只卸载配置中的成员；`off` 会加载它们。成功的主动卸载状态在 Host 重启后仍然保留，并暂停匹配的健康探针、使匹配 provider 路由上的 Agent 模型请求失败，以及将匹配的 cron 触发记为跳过。命令只对已配置的 Agent 预设开放，不进入模型工具目录。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

挂载此 Host 插件时，显式指定状态文件、操作者身份、授权预设及后端：

```yaml
- name: '@deepseek-ai/dsh-local-model-control'
  config:
    stateFile: /var/lib/dsh/local-model-control.json
    operatorName: Operator
    allowedPresets: [operator]
    backends:
      - name: local
        kind: docker
        container: local-model
        routes: [local-provider]
        healthUrl: http://127.0.0.1:8000/v1/models
        loadTimeoutMs: 300000
    groups:
      gaming: [local]
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `stateFile` | 必填 | 持久化状态的绝对路径；首次成功操作时创建父目录 |
| `operatorName` | 必填 | 在状态中与卸载时间一起显示的人名 |
| `allowedPresets` | 必填 | 允许调用所有控制命令的 Agent 预设 ID |
| `backends` | 必填 | 唯一的后端名、固定 Docker 容器或 halorun 配置及 SSH 目标、唯一 provider 路由、可选健康 URL 与加载超时 |
| `backends[].holdFile` | 无 | halorun 后端可选的远端看门狗暂停文件；使用安全的绝对路径或 `~/` 路径 |
| `groups` | `{}` | 命令名到非空后端列表的映射 |
| `commandTimeoutMs` | `30000` | 每个控制进程的时限 |
| `healthPollMs` | `1000` | 加载时健康检查之间的等待 |
| `graceMs` | `1000` | 子进程终止宽限时间 |

`/models status` 报告每个后端的意图状态。`/models unload <name>` 停止配置的目标，然后持久化操作者与时间。配置了 `holdFile` 的 halorun 后端会在停止前创建远端父目录和暂停文件，并在启动前删除该文件。暂停文件操作失败时，不会执行 halorun 命令。`/models load <name>` 启动目标；若配置健康 URL，则等待 HTTP 200，再清除卸载意图。加载失败会保留原状态。分组命令按配置顺序操作；成员失败时停止并报告此前成功的成员。[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-local-model-control)说明加载器 schema。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>展开查看实现内部机制</summary>

Host 服务将主动卸载映射提供给健康探针与 cron。一个前置注册的 Host `agent/request` 监听器读取每个 Agent 模型请求的最终 provider 路由；若该路由已卸载，则在记录请求头或适配器收到调用之前抛出 `LOCAL_MODEL_UNLOADED`。同一个 Host 中的修改命令串行执行，并原子替换状态文件。子进程请求明确指定 argv、工作目录、有界输出、时限、取消信号与终止宽限；部署字符串在挂载前校验为安全标记。远端暂停路径使用绝对路径或 `~/` 写法以及安全的路径段；创建或删除文件分别通过受检查的 SSH argv 命令执行。健康探针按配置 URL 精确匹配；cron 在预留 Session 前检查任务选定的 provider。

| 源码 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 校验、持久化、进程控制、命令与只读状态 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [健康插件](../health/README.zh.md) — 暂停的探针与面向人的 `/status`。
- [Cron 插件](../../cron/cron/README.zh.md) — 持久化的跳过触发历史。
- [Agent 包](../../core/agent/README.zh.md) — 请求准入所监听的 `agent/request` waterfall。

-----

<a id="model-experience"></a>
## 模型体验

无，因为人类控制命令不增加模型可见工具或提示词。

#### KV 缓存影响

无；控制器不向模型请求增加 token。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **状态记录意图，而非独立的进程状态。** 加载后使用健康探针观察可达性；`/models status` 不轮询容器或远端进程列表。
- **一个 Host 负责修改。** 进程内队列串行执行一个网关的命令；多个网关共用状态文件时，部署必须另行保证单一所有者。
- **状态写入失败会报告错误。** 卸载成功后，此 Host 仍在内存中保持后端暂停；重启前应修复存储，以保留该意图。
- **只检查 Agent 请求。** Agent 轮次之外直接调用 `ctx.llm` 的调用方（例如压缩摘要与会话标题）在已卸载路由上仍会到达适配器。路由卸载时已在适配器中排队的请求不会被重新检查。
- **远端控制使用 SSH 命令传输。** 目标与远端命令标记由已校验配置固定；控制器不把命令文本作为 argv。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作说明 — 点击展开</summary>

只读服务是供消费者避开主动卸载路由的 Host 扩展点。不发布运行时 invariant：一个控制器拥有该映射，每次读取直接从中派生。

</details>
