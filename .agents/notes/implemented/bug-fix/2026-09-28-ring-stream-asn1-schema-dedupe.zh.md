# Agent Note: Ring 直播流需要单一 asn1-schema 副本

Status: implemented

[English](2026-09-28-ring-stream-asn1-schema-dedupe.md) | 中文

## Problem

每次 Ring 直播流回退都失败，先报 `camera-ring: ring-client-api: Cannot get schema for 'SubjectPublicKeyInfo' target`，随后是 `stream capture … failed at ended-short: the call ended with 0 of 2 frame(s) written`。每次 WebRTC 通话前，`ring-client-api` 14.3.0 会让 `werift` 0.22.4 通过 `@peculiar/x509` 1.14.3 创建自签名 DTLS 证书。锁文件为 `@peculiar/x509`、`@peculiar/webcrypto` 与 `webcrypto-core` 解析出 `@peculiar/asn1-schema` 2.9.4，而为 `@peculiar/asn1-*` 2.9.5 各包解析出 2.9.5。`asn1-schema` 按模块副本保存模式注册表，因此 `@peculiar/asn1-x509` 通过 2.9.5 副本注册的 `SubjectPublicKeyInfo` 对 `@peculiar/x509` 用来序列化的 2.9.4 副本是未知的。证书创建抛出异常，通话从未开始。

## Decision

根目录 `pnpm-workspace.yaml` 为所有使用方把 `@peculiar/asn1-schema` override 为 2.9.5，即 `@peculiar/asn1-*` 各包所要求的版本。锁文件因此只含一个 `@peculiar/asn1-schema` 条目。

`camera-ring/tests/dtls-certificate.spec.ts` 从 `ring-client-api` 的真实包目录经由 werift 的 ESM `import` 导出，加载 `ring-client-api` 所导入的那份 `werift` 构建，并以其 DTLS 传输所用的 ECDSA P-256 与 SHA-256 参数调用 werift 的 `createSelfSignedCertificate`。该测试不访问网络；锁文件再次拆分 `asn1-schema` 时，它会以 `SubjectPublicKeyInfo` 错误失败。

## Alternatives considered

**限定作用域的 `parent>child` override。** 仅 `@peculiar/x509>@peculiar/asn1-schema` 就能修复证书创建，但 `@peculiar/webcrypto` 与 `webcrypto-core` 仍留在第二份副本上。逐一列出所有父包只能在新使用方出现之前保持单一副本，而需要保证的是每个进程只有一个注册表。

**`pnpm dedupe`。** 它现在能合并副本，但会改写无关的锁文件条目，之后的解析也可能在安装不报错的情况下再次拆分。

**在 `camera-ring` 中直接依赖 `werift`。** 这样测试可以按名称导入 `werift`，但可能解析到与 `ring-client-api` 实际运行版本不同的版本。

## Consequences

把 `@peculiar/asn1-*` 各包升级到要求更新 `asn1-schema` 的版本时，需要在同一变更中提高该 override；若 override 强制使用的不兼容副本破坏证书创建，回归测试会失败。已有的 `node_modules/.pnpm` 在重新安装后可能保留一个孤立的 `@peculiar+asn1-schema@2.9.4` 目录；没有任何链接指向它，干净安装也不会创建它。
