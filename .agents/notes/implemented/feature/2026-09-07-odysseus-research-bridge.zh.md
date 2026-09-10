# Agent Note: 显式选择工作模型的 Odysseus 研究任务

Status: implemented

[English](2026-09-07-odysseus-research-bridge.md) | 中文

## 问题

Beardy 需要通过已安装的 Odysseus 服务和指定的本地工作模型开展多轮研究。已安装的研究 CLI 无法启动任务，仅接受浏览器会话的研究路由拒绝 bearer 启动请求。

## 决策

[研究工具](../../../../packages/web/tool-odysseus-research/README.zh.md)发送有界 HTTP 请求，端点、模型、凭据引用和研究预算由部署配置指定。Beardy 提供禁用条目，由个人配置启用。重定向和自动重试均被拒绝。

Odysseus 负责任务生命周期和报告保存。Harness 通过普通工具结果记录远程标识、状态、报告页面和来源 URL。非消耗式 `result-peek` 读取保留报告。HTTP 取消不会停止已接受的远程工作；调用者通过 `list` 查找启动结果不明确的任务，并用 `cancel` 显式停止任务。配套 Odysseus 修改将 `research:read` 授予 active/status/library/peek，将 `research:run` 授予 start/cancel，解析令牌所有者并保留所有权和研究权限检查。这些令牌仍无法执行其他浏览器操作。

## 考虑过的替代方案

**CLI 集成：**已安装的 CLI 无法启动研究，直接访问文件还会绕过 HTTP 所有者过滤。

**Harness 管理的后台任务：**复制远程注册表需要持久任务接管、完成通知和取消协调。显式读取状态保留远程所有权，不承诺自动通知。

**交互式凭据：**研究限定令牌限制长期 API 权限，无需在桥接配置中保留浏览器 cookie 或密码。

## 影响

桥接使用现有工具注册和 Session 事件。测试覆盖工作模型选择、Loader 激活与卸载、请求限制、重定向、取消、格式错误的响应以及报告分页。无需密钥的[会话回放场景](../../../../snapshots/session/odysseus-research/snapshot.yml)通过 HTTP 固件执行真实工具。实时 4B 报告质量需要单独进行运行检查。现有 Beardy 组合和 MCP 决策继续有效，因为其职责未被替代。
