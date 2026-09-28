# Agent Note: Ring 截取失败会说明原因

Status: implemented

[English](2026-09-28-camera-ring-stream-diagnostics.md) | 中文

## 问题

2026-09-28 全部 18 个实时 Ring 事件都记录了 `captureFailure: 'stream-failed'`，每个只带一到两张快照画面而不是三张。`captureStream` 在三处返回 `stream-failed`：启动被拒绝或抛出异常、启动超过 `streamSetupMs`、直播流留下的画面文件少于请求数量，并且每次都丢弃了原因。`ring-client-api` 通过自己的进程级日志器报告信令、WebRTC 和 ffmpeg 故障，而该日志器默认只写入 `ring` 调试命名空间，因此日志中没有任何说明原因的内容。

## 决策

**截取结果携带诊断信息。** `CaptureResult` 新增 `snapshotMiss`，即结束快照阶段的那张快照及其原因（`stale`、附带厂商错误的 `refused`，或 `timeout`）；以及 `streamFailure`，仅在 `failure` 为 `stream-failed` 时出现，给出所处阶段：附带错误的 `start-refused`、附带 `streamSetupMs` 的 `start-timeout`、通话先结束时的 `ended-short`，或截取时限将其停止时的 `run-timeout`，后两者附带已写入帧数与请求帧数。`CameraCaptureFailure` 的取值和截取行为保持不变。

**提供方为每个原因记录一行日志，并像其他诊断信息一样脱敏。** 快照缺失在 `info` 级别记录 `camera-ring: snapshot <n> for <event id> <reason>; streaming the remaining <k> frame(s)`，或 `…; stream fallback is off`。直播流失败在 `warn` 级别记录 `camera-ring: stream capture for <event id> failed at <stage>: <cause>`。

**在提供方生命周期内把库日志器转发到 `ctx.logger`。** `logError` 变为 `warn`，`logInfo` 变为 `debug`，二者都带 `camera-ring: ring-client-api:` 前缀并经过脱敏。经校验的布尔配置 `vendorDebug`（默认 false）调用库的 `enableDebug()`，这也会暴露 ffmpeg 的 stderr，并把 `logInfo` 行记录为 `info`，使其在默认日志级别下也能进入日志。该库无法报告其默认日志器，因此卸载时安装一个丢弃所有行的日志器；它也无法关闭调试，因此 `vendorDebug` 一直开启到进程退出。

## 考虑过的替代方案

**新增按阶段区分的 `CameraCaptureFailure` 取值。** 这会为运维诊断改变摄像头事件契约及其所有消费者，而这并不是模型或用户可见的区别。

**在 `captureFrames` 内记录日志。** 截取没有日志器，也没有令牌秘密；返回结构化细节能让它保持为纯粹的接缝，并由提供方在一处完成脱敏。

**设置 `RingApi({ debug: true })`。** 它打开的是与 `enableDebug()` 相同的进程级开关，但要经客户端工厂在每次连接尝试时设置；在加载时调用一次 `enableDebug()`，能让该开关与使其日志可见的日志器转发放在一起。

## 影响

下一次失败的实时截取会在日志中写出所处阶段；结合 `ring-client-api:` 警告行，可以区分 Ring 拒绝、通话在应答前结束、ffmpeg 退出，以及直播流送达的画面过少。截取测试固定了每个阶段和快照原因；提供方测试固定了确切的日志行、脱敏、日志器转发和 `vendorDebug`；客户端测试驱动真实的 `ring-client-api/util` 日志器。模型可见输出和会话输出都没有变化，因此没有会话快照变化。
