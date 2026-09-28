---
description: "ctx.camera 的 Ring 提供方：按凭据引用用刷新令牌登录、推送事件、冷却时间和有界画面截取。"
kind: "package-reference"
---

# @deepseek-ai/dsh-camera-ring

[English](README.md) | 中文

## 概述

通过非官方的 [`ring-client-api`](https://github.com/dgreif/ring) 库监视 Ring 门铃和摄像头。提供方用已存储的刷新令牌登录，把每次轮换后的令牌写回同一凭据引用，接收已配置设备的门铃和移动推送，并为每个被接纳的事件发布几帧已存储的画面。画面来自事件发生时及其后固定间隔的按需快照；快照失败或与上一张重复时，由主机 ffmpeg 处理的一段短直播流补齐其余画面。

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

在 harness 之外运行一次该库的登录命令（`npx -p ring-client-api@14.3.0 ring-auth-cli`），回答邮箱、密码和两步验证提示，再把输出的刷新令牌存到受管凭据存储中的某个凭据引用下，例如 `$DSH_HOME/.credentials.yaml` 里的 `RING_REFRESH_TOKEN`。引用未设置，或解析自进程环境等只读来源时，提供方拒绝加载，因为无法写回的轮换会让下次重启拿到过期令牌。

| 配置 | 含义 |
|---|---|
| `refreshTokenRef` | 保存刷新令牌的凭据引用；轮换结果写回此处 |
| `devices` | 每个受监视设备的 `{ id, label, ringId }` 或 `{ id, label, ringName }`；名称匹配不区分大小写 |
| `events` | 接纳的事件类型，默认 `motion` 和 `ding` |
| `frameCount`、`frameIntervalMs` | 每个事件的画面数（默认 3）及间隔（默认 10 秒） |
| `snapshotTimeoutMs` | 单张快照的最长等待时间 |
| `streamFallback`、`ffmpegPath`、`streamSetupMs` | 快照失败或重复时的直播流回退、它所需的 ffmpeg 绝对路径及启动时限 |
| `motionCooldownMs`、`dingCooldownMs` | 同一设备同类事件之间的最短接纳间隔 |
| `dedupeWindowMs`、`dedupeMaxIds` | 厂商事件 ID 抑制重复推送的时长和数量 |
| `reconnectDelayMs`、`maxReconnectDelayMs` | 连接失败后逐次翻倍的重试延迟 |
| `controlCenterDisplayName` | Ring 在已授权设备中为此客户端显示的名称 |
| `vendorDebug` | 打开 `ring-client-api` 的调试日志（含 ffmpeg 输出），以 `info` 级别记录；输出很多，默认关闭，加载后一直开启到进程退出 |

账户中不存在的已配置设备会让提供方停止并报错，错误信息列出账户中所有设备的名称和 ID。其他原因导致的连接失败（例如 Ring API 不可达）会以翻倍延迟重试。

要查明事件画面少于 `frameCount` 的原因，请查看提供方日志。`info` 级别的 `camera-ring: snapshot <n> for <event id> …` 指出把截取转到直播流的那张快照，以及它是与上一张重复、被拒绝还是超时。`warn` 级别的 `camera-ring: stream capture for <event id> failed at <stage>: <cause>` 指出 `stream-failed` 截取停在哪一步：`start-refused` 附带 Ring 错误，`start-timeout` 表示 `streamSetupMs` 内没有启动直播流，`ended-short` 表示通话先结束，`run-timeout` 表示截取时限将其停止，后两者附带已写入帧数与请求帧数。`warn` 级别的 `camera-ring: ring-client-api: …` 是该库自身的错误，例如信令套接字失败或 ffmpeg 退出码；短时开启 `vendorDebug` 还能看到 ffmpeg 的输出。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

加载时检查凭据引用和 ffmpeg 可执行文件，然后在后台连接。第一次请求会刷新令牌；`ring-client-api` 在推送凭据变化时也会重新编码令牌，每个新值都按轮换顺序经 `ctx.credentials.set` 写回。诊断信息（包括提供方加载期间经 `ctx.logger` 转发的库自身日志）会把封装令牌及其内部 Ring 令牌替换为 `[redacted]`。

推送按厂商事件 ID 只接纳一次：只接纳已配置的类型，只在该设备该类型的冷却时间之外接纳；移动事件还要求该设备当前没有在截取画面，门铃按下则排在正在进行的截取之后。每个被接纳的事件最多获得 `frameCount` 帧：收到推送时一张快照，此后每个间隔一张。有线 Ring 摄像头在移动期间可能再次返回缓存的快照，因此字节与上一张相同的快照与被拒绝或超时的快照一样，算作缺失的实时画面。缺少快照且开启 `streamFallback` 时，一次直播通话运行带帧率过滤器的 ffmpeg，把该时段及之后所有时段的画面写入私有临时目录，之后删除该目录。画面经 `ctx.attachments` 以 JPEG 存储；第一帧存储后先以 `camera/preview` 发布，再继续截取，最后一帧之后发布完整事件。数量不足时，回退关闭时事件标注 `snapshot-unavailable` 或 `snapshot-stale`，直播流提前结束时标注 `stream-failed`，存储失败时标注 `storage-failed`。卸载时停止订阅、取消等待、断开连接，并等待截取和令牌写入结束。提供方只保存临时的接纳状态，因此不发布不变量组件。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Camera 子系统](../../../docs/subsystems/camera.zh.md) — 事件、画面和判定。
- [摄像头监视](../camera-watch/README.zh.md) — 分类、通知和历史。

-----

<a id="model-experience"></a>
## 模型体验

### Ring 提供方

#### 模型看到的内容

提供方不注册工具、模式或提示词。它的画面只通过摄像头监视记录在案的分类 `user/message` 到达模型。

#### Token 影响

提供方不增加模型 token。

#### KV Cache 影响

提供方不改变请求缓存。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- Ring 没有官方 API；Ring 端的变化可能导致登录、推送或快照失效，直到 `ring-client-api` 跟进。
- 推送经 Firebase Cloud Messaging 送达，主机需要能向外连接 `mtalk.google.com` 的 TCP 5228 端口。
- 一个刷新令牌应只由一个 harness 进程持有。两个进程共用时会各自轮换，可能互相使令牌失效。
- Ring 应用的模式关闭移动侦测时快照会停止，此时由直播流回退提供画面。
- 直播流在推送后几秒才开始，因此流式画面比快照画面晚。
- `ring-client-api` 每个进程只有一个日志器和一个调试开关，且无法读取或恢复其默认日志器；卸载提供方会让库日志静默，`vendorDebug` 一直开启到进程退出。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
