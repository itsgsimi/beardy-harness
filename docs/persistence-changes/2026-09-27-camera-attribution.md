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
    after: "b2b7593c1e987d76d27f723640214713ef61c99e056edf55b93fb25733a7d6c4"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-27-downstream-v4-attribution"
    after: "27e5ed89fb079b8ddc0d363015e1916254a85963f6be5352e4a4737830dcdf53"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-27-downstream-v4-attribution"
    after: "2c4d5438355906bb05a9e3ecd936d3809628ce573d8de93002c8eb37e740d043"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-27-downstream-v4-attribution"
    after: "1d53335fb8a9300e52ef98428d8eddb3abd8584ce7cdce52f4910ebd5f88d4e8"
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
