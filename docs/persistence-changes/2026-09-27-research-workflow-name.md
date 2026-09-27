---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-27-research-workflow-name

English | [中文](2026-09-27-research-workflow-name.zh.md)

## Summary

Adds the optional consumer workflow name to the persisted research run start event.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-27-research-workflow-name
baseline: false
changes:
  - root: "event:research/started"
    previous: "2026-09-27-research-engine-events"
    after: "a75ce2460c0aff11afa12c5a18af38a952ca5d01294c8ed79bbda6f6f68f8f6c"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid: runs of the general engine omit the field, as every earlier run does. A run started with a consumer workflow records the workflow name next to its prompt version and budgets; readers use it only to identify the procedure that produced the report, and its absence means the general engine.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/research/research-local packages/fantasy/fantasy-reports: 131 tests passed; the fantasy-report headless snapshot replays the recorded run with the field.

<a id="dev-note"></a>
## Dev Note

None.
