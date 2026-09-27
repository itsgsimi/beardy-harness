---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-27-research-run-events

English | [中文](2026-09-27-research-run-events.zh.md)

## Summary

Adds durable research run creation, caller linkage, checkpoints, and terminal outcomes.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-27-research-run-events
baseline: false
changes:
  - root: "event:research/checkpoint"
    previous: null
    after: "e4f6dc1f097c473d7b9a0e99f31ea2b3f80fa334e8ba5728f7ed15e382413044"
    decision: same-version
  - root: "event:research/finished"
    previous: null
    after: "624e3d25a6a6bfc56db462668486fb8213a27fc70e491fa9ceaf2a5e4ee94229"
    decision: same-version
  - root: "event:research/linked"
    previous: null
    after: "428258651791def845d5cda5c471d5e38b692e4118e40def1cecae39b874b5fa"
    decision: same-version
  - root: "event:research/started"
    previous: null
    after: "98162ec1623806fed5f2ee52ef1e2499636f2dde53906b9f6d8d7b63c1d145f1"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The four event roots are additive within the current Session format. Earlier logs contain none of them and retain their existing interpretation. A reader without these required event types refuses a research run log rather than silently treating its lifecycle as complete.

<a id="verification"></a>
## Verification

Focused research-local unit and Loader composition tests passed (22 tests). The TypeScript SDK recorded-session replay and Python advanced runtime snapshot project a fixture `research/linked` through their event streams. The persistence change classifier reports four same-version root additions. No shipped SDK profile emits research events until a research consumer mounts the provider.

<a id="dev-note"></a>
## Dev Note

None.
