---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-27-research-engine-events

English | [中文](2026-09-27-research-engine-events.zh.md)

## Summary

Records bounded research engine settings, web search and fetch outcomes, and normalized source findings alongside stage Session references.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-27-research-engine-events
baseline: false
changes:
  - root: "event:research/checkpoint"
    previous: "2026-09-27-research-run-events"
    after: "2dcdb67f2a13f8dcc596b04867df89eafed49c5202efaa69b58942be90c74ab7"
    decision: same-version
  - root: "event:research/finding"
    previous: null
    after: "2328d6dc1706dfd6cc74a1e299de3b1714cb9fd49217c0a37187be1befa0c77a"
    decision: same-version
  - root: "event:research/search"
    previous: null
    after: "52261b4041cd97429dbfd487040d4829dfe0ab225e067cbaf1aa1e8b951d98a9"
    decision: same-version
  - root: "event:research/source"
    previous: null
    after: "2a51521026afc8af908bb4dd436f5194339657b9cf0d0bc6297909fa0f29fd81"
    decision: same-version
  - root: "event:research/started"
    previous: "2026-09-27-research-run-events"
    after: "529706ff9af0dab0db17b170e4dca4a814abad1ca1157125ce7e33e5311071f3"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The new search, source, and finding events are additive in the current Session format. The started and checkpoint payloads gain optional fields, and source metadata gains optional retrieval fields. Earlier research logs remain readable. Readers without the new required event names refuse engine run logs instead of silently omitting evidence.

<a id="verification"></a>
## Verification

Focused research, web, Session Controller, and session-query tests passed (208 tests). The persistence classifier checks the same-version additions and optional-field changes. Stage request reconstruction and cancellation paths are exercised with a mock model and web provider.

<a id="dev-note"></a>
## Dev Note

None.
