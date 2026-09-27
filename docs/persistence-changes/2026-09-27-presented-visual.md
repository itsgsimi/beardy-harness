---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-27-presented-visual

English | [中文](2026-09-27-presented-visual.zh.md)

## Summary

Adds an optional saved visual snapshot to each presented file in deliverables/presented. The Session writer stays on format version 3.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-27-presented-visual
baseline: false
changes:
  - root: "event:deliverables/presented"
    previous: "2026-09-11-initial"
    after: "c63a3a594df4cfda0975b91dad916d6bb62f83058fb48a049a6c923495c5561c"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing events omit visual and still replay as ordinary file deliveries. Current readers accept its absence; older readers can ignore the optional visual bytes and retain each file's path and description. The addition changes neither the event envelope nor existing fields, so no adjacent migration is needed.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/fs/tool-present/tests/present.spec.ts passed 20 tests, including visual event replay and ordinary deliveries. The persistence classifier reports one optional-property-added change for this event root and no version bump.

<a id="dev-note"></a>
## Dev Note

None.
