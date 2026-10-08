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
    previous: "2026-09-21-user-question-reply"
    after: "08348dba2b18a0f5f93340a147b63421fd4b9f1c8b5b839f047d8f74408d412e"
    decision: same-version
  - root: "event:deliverables/presented"
    previous: "2026-09-11-initial"
    after: "c63a3a594df4cfda0975b91dad916d6bb62f83058fb48a049a6c923495c5561c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "061fac9576f9394bfad5043d69ad58e419dd36313ba79f67298f889c61b86acf"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "10432669237d646344b3c11376cd99c3af38539879fe69e790c655d722a2455c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "0781a212498552eb2b2e4f2e66769577096b0b7dca64ead23410009298c17613"
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
