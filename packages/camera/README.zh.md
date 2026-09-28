---
description: "摄像头事件服务、Ring 提供方，以及负责分类、通知并回答 camera 工具的监视插件。"
kind: "package-group"
---

# packages/camera

[English](README.md) | 中文

## Summary

把门铃按下和移动警报变成简短准确的通知。Ring 提供方为每个事件截取几帧画面；监视插件在一次记录在案的视觉模型轮次中对画面分类，应用通知策略，经 Discord 网关发件箱发送附带一帧画面的通知，并保存供 `camera` 模型工具读取的事件历史。

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [camera](camera/README.zh.md) | 设备、事件、画面和判定类型 | `ctx.camera` 定义 |
| [camera-ring](camera-ring/README.zh.md) | Ring 账户连接、推送事件和画面截取 | `ctx.camera` 提供方 |
| [camera-watch](camera-watch/README.zh.md) | 分类轮次、通知策略、历史和 `camera` 工具 | 服务使用方 |

-----

<a id="related-documentation"></a>
## Related documentation

- [Camera 子系统](../../docs/subsystems/camera.zh.md) — 事件、画面、判定和通知交接。

-----

<a id="dev-note"></a>
## Dev Note

无。
