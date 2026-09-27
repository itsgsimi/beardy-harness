---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-27-downstream-v4-attribution

English | [中文](2026-09-27-downstream-v4-attribution.zh.md)

## Summary

Adds downstream Discord and cron message attribution, the skill notice source, captured user memory, and optional presented visual metadata to V4 records.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-27-downstream-v4-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-16-session-format-v4"
    after: "8993290365012d0f5cd5f71bb1a3f2cb1023f1e3c0121699758b51bf4b8606a9"
    decision: same-version
  - root: "event:deliverables/presented"
    previous: "2026-09-11-initial"
    after: "c63a3a594df4cfda0975b91dad916d6bb62f83058fb48a049a6c923495c5561c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "5aa733f99294311254ec09718c78ffc52f560cba0c865399619879da597d8a25"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "4d98bd872dcf806a09702b00abe03c3038d9546931bc752b58402b8877fd7c2b"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "379f8afe7399f9b1a1aa95c55812348b92e54b52665cdf1272efe543038beff6"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing V4 messages remain valid. Discord, cron, and skill notice kinds only attribute preserved message content; readers without those producers retain their kind and JSON metadata without requiring the producer. The instruction baseline's frozen user files and each presented file's saved `visual` are optional, so their absence keeps the existing reading path. Older readers can ignore visual bytes while retaining the file path and description. V3 migration retains direct producer sources and captured instruction data. Older V4 readers preserve unknown source kinds and ignore the optional fields.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/client/ui-settings-plugins/tests/research-card.client.spec.tsx packages/session/session-format-v3-to-v4/tests/message-sources.spec.ts: 15 tests passed; pnpm run typecheck passed.

<a id="dev-note"></a>
## Dev Note

None.
