---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-27-camera-attribution

English | [中文](2026-09-27-camera-attribution.zh.md)

## Summary

Adds the camera watch's `camera` user-message attribution to V4 records.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-27-camera-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-27-downstream-v4-attribution"
    after: "7c1987d9b1c801697bbbc560ffbc083d81950d0f9227e811083e1c9cdaa50ec3"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-27-downstream-v4-attribution"
    after: "acf82f65e2a2c1f8a273e62e55094ec9db8bf6a033a5c6c32dd0f0ca1d9cbbc8"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-27-downstream-v4-attribution"
    after: "19668724e4be71c8e670166ba64b8ece58b8785aead9cd3984dd22b49d534f78"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-27-downstream-v4-attribution"
    after: "3ffa848524b9772a269f2edbd5f09cd671558b854546970fabd8107cf9f9f6f2"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing V4 messages remain valid. The `camera` kind only attributes a classification Session's prompt message, which carries its text and image blocks unchanged; readers without the camera watch preserve the kind and its JSON metadata and derive the message normally. Older V4 readers preserve unknown source kinds. No V3 Session carries this kind, so migration is unaffected.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/camera/camera-watch/tests/watch.spec.ts: 22 tests passed; pnpm run typecheck passed.

<a id="dev-note"></a>
## Dev Note

None.
