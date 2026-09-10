# Agent Note: 显式启用无令牌 Web 访问

Status: implemented

[English](2026-09-09-explicit-token-free-web-access.md) | 中文

## 问题

受监督的 Web 服务可以在无人值守的终端环境下运行，但新浏览器仍需要进程启动 URL 才能登录。有些操作者明确信任私有网络中的所有客户端，希望使用稳定 URL，而不必分发浏览器令牌。无界面启动本身不能表达这种访问策略。

## 决策

Web CLI（命令行界面）提供 `--insecure-no-auth`，将 Connection 经校验的 `insecureNoAuth` 配置设为 true，并打印明确警告。默认仍启用浏览器认证。`--no-open` 只抑制浏览器启动，绝不改变认证。CLI 仅在同时显式退出认证时接受 `--host 0.0.0.0`。

在不安全模式中，Connection 无需令牌或 cookie 即可处理可信的 index 请求及完整 Host API，包括 WebSocket 升级。启动 URL 是不含认证信息的应用根地址。Connection 在此模式下既不加载也不创建浏览器签名记录，并保留既有凭据。[Connection 包](../../../../packages/client/connection/README.zh.md)持有该策略；[Web 组合包](../../../../packages/bundle/web-app/README.zh.md)持有调用方式和 LAN 绑定。

Host、Origin、Fetch-Metadata 与请求体检查继续生效。绑定全部接口时会推导可信的 LAN IP authority；`--trusted-host` 可以增加显式名称。这些检查拒绝浏览器跨站和重绑定尝试，但不认证网络客户端。任何能够到达端点并提供被接受请求头的客户端，都拥有 harness 用户的完整 Host 权限。

这是[浏览器令牌认证](../architecture/2026-08-24-browser-token-authentication.zh.md)的显式例外，同时保留该说明关于凭据、有效期和默认认证的理由。[浏览器信任决策](../architecture/2026-07-28-api-browser-trust-boundary.zh.md)继续有效，因为两种模式都应用其请求检查。两个说明均未被完全取代。

## 曾考虑的替代方案

**仅保留浏览器登录策略。** 持久 cookie 减少重复登录，但每个新浏览器仍需要启动 URL。这无法满足操作者主动允许所有可达客户端访问的选择。

**从无界面启动或 LAN 绑定推断访问策略。** 抑制浏览器或选择 socket 地址不表示同意取消认证。单独且醒目的参数让服务命令行明确呈现该策略。

**移除整个请求信任检查。** 无令牌访问不需要允许跨站浏览器请求或攻击者控制的 Host 名称。共享检查继续为每条路由提供这些保护。

## 后果

无令牌服务 URL 可以跨重启使用，无需配置浏览器。操作者放弃调用者身份识别，必须控制网络可达性；该模式不增加 TLS、用户账户或受限 API 层级。移除参数会恢复浏览器认证，并保留既有签名记录。

聚焦的 Connection 测试覆盖显式退出认证和保留的信任拒绝。真实 CLI 场景检查无 cookie 的 index 与 RPC 访问、不含认证信息的启动 URL，以及恶意请求拒绝，同时保留默认令牌交换与重启行为。
