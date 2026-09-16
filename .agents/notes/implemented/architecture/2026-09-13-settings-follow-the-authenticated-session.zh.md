# Agent Note: Settings persistence follows the authenticated session, not the page authority

Status: implemented

[English](2026-09-13-settings-follow-the-authenticated-session.md) | 中文

## 问题

设置域的浏览器半边从页面自身的主机名选择持久化方式：`ui-settings` 把 `ctx.remote.$host.isLoopback` 解析为 `'host' | 'memory'`，非 loopback 页面取 `'memory'`。在该模式下，describe 镜像从不调用 `settings/describe`，每个绑定的命名空间 scope 都以 `unavailable` 开启，排队的写入被丢弃。

可见结果是一个失败却不说明原因的设置界面。模型页报告 `settings are unavailable in this browser`——这条兜底文案之所以被触及，是因为内存模式让镜像的视图保持 undefined 而错误保持 null；插件页则什么都不画，因为它要等宿主回答一次才绘制空行，而该回答永不到来。外观、语言、忙碌回车、权限预设行与欢迎声明都静默保留各自的临时默认值。一个服务 LAN 或 Tailscale 授权方的部署会失去整个配置界面，而 Web 应用的其余部分照常工作。

该门禁早于统一认证。[浏览器启动令牌认证](2026-08-24-browser-token-authentication.zh.md)此后把身份收敛为一份在分发前校验的应用凭据，`Host` 不再授予更高的方法层级；同一决策也记录了：从请求路由事实判定特权调用方，正是它修复的缺陷。`settings/describe` 与 `settings/mutate` 是普通的已认证方法，因此在它们前面放一道页面授权门禁，等于主张一条宿主已不再承认的边界。

## 决策

浏览器只要持有连接，就读写宿主设置文档。`SettingsDescribeMirror` 与 `SettingsScopeController` 去掉 `persistence` 参数，`SettingsScopeSnapshot` 去掉 `mode` 字段，镜像的状态联合去掉 `unavailable`。scope 自身的 `unavailable` 状态保留：它现在只指称一种情形，即组合未提供该命名空间。

谁可以调用仍然完全是宿主的问题，本决策不改变它：[载体级浏览器信任决策](2026-07-28-api-browser-trust-boundary.zh.md)的媒体类型与授权方围栏先准入请求，随后 Connection 对其认证，除非启用了[显式免令牌访问](../feature/2026-09-09-explicit-token-free-web-access.zh.md)。`trustedHosts` 依旧不授予身份，本决策也不新增任何可令其授予身份的路径——能够触及设置方法的客户端，已经满足了该部署所配置的策略。

`ui-settings-general` 保留其 `isLoopback` 分支。宿主文档操作会在宿主自己的屏幕上打开文件，因此对这一个操作而言页面授权正是该问的问题，`ctx.connection.isLoopback` 仍是它的来源。

欢迎声明失去其进程内确认路径，该路径的存在只是为了给内存模式一个答案。未提供的命名空间现在会让该步骤进入错误状态，而不是静默丢弃确认。

## 考虑过的其他方案

**以 `trustedHosts` 为特权界面的依据。**已配置的授权方列表是「放我的 LAN 进来」最显眼的杠杆，也是错误的那一个：浏览器信任决策写明 `--trusted-host` 扩展 Host 与 Origin 围栏且不授予身份。把它读作身份，会重建令牌认证已移除的路由事实授权模型，而且是在客户端重建——那里甚至不知道这份列表。

**在宿主侧声明该事实并保留内存模式。**在 `RemoteEventHostInfo` 上加一个字段，可以把决策放在事实所在之处，并为真正不受信的查看者保留进程内模式。这样的查看者并不存在：宿主在发送任何帧之前就会拒绝未通过围栏或认证的调用方，因此该字段对每个读得到它的客户端都为真。这个线上字段及其管道所承载的区分，系统无法表达。

**把该选择做成受校验的 `Config` 字段。**随部署而变的选择属于 `cordis.yml`，但这一项并不随部署而变——它是宿主在准入连接时已经回答过的问题。一个旋钮只会让某个组合宣称一项宿主并不执行的限制。

## 后果

浏览器只要位于部署准入的任一授权方上，就能获得其 loopback 对应物所获得的设置、模型与插件界面。

偏好从按设备变为跨设备共享。在手机上选择的外观、字号与语言会写入 `settings.yaml` 并抵达同一 Harness home 上的其他每个浏览器；先前的按页面兜底已不存在。在一台设备上确认的欢迎声明在所有设备上都保持已确认。

被准入 API 的调用方可以写入设置文档。这不新增任何权限：同一调用方本就能触及 `session/prompt`，后者以操作者的 shell 运行一个 agent。在 `--insecure-no-auth` 下服务非 loopback 授权方的部署，会把这两项能力一并扩展给所有能触及该套接字的人，而这项可达性决策仍在原处，即 webserver 绑定与认证豁免开关。

聚焦单元覆盖在旧门禁被钉住之处钉住新行为：非 loopback 页面加载持久的主题分区并经其写入，且读取持久的欢迎确认。`ui-settings-general` 保留一个用例，证明宿主文档操作在非 loopback 下仍被扣留，而设置读取照常进行。
