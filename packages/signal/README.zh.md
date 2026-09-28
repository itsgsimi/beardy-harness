---
description: "Signal 服务定义、signal-cli 守护进程提供方，以及把摄像头、健康和定时运行通知投递到 Signal 的使用方。"
kind: "package-group"
---

# packages/signal

[English](README.md) | 中文

## Summary

把 Beardy 的通知发到 Signal 群组或账户，替代 Discord 或与其并存。本地 signal-cli 守护进程经持久发件箱发送每条消息，并把收到的消息以流的形式送回；通知使用方认领目标为 `signal:group:<id>` 或 `signal:number:<E.164>` 的每条摄像头通知、健康状态转换和定时运行投递。

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [signal](signal/README.zh.md) | 外发消息、健康状态和收到消息的类型 | `ctx.signal` 定义 |
| [signal-cli](signal-cli/README.zh.md) | signal-cli HTTP 守护进程客户端、持久发件箱和事件流 | `ctx.signal` 提供方 |
| [signal-notices](signal-notices/README.zh.md) | 目标为 Signal 的摄像头、健康和定时运行通知 | 服务使用方 |

-----

<a id="related-documentation"></a>
## Related documentation

- [Signal 子系统](../../docs/subsystems/signal.zh.md) — 投递目标、发件箱和收到的消息。
- [投递目标](../util/delivery-target/README.zh.md) — 每个通知生产方校验的目标语法。

-----

<a id="dev-note"></a>
## Dev Note

无。
