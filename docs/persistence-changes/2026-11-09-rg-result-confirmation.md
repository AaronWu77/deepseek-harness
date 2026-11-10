---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-09-rg-result-confirmation

English | [中文](2026-11-09-rg-result-confirmation.zh.md)

## Summary

Adds durable preparation and confirmation events for completed RG role results.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-09-rg-result-confirmation
baseline: false
changes:
  - root: "event:review-gated/result-confirmed"
    previous: null
    after: "626cdd354afb3995ce2f09e4f2a85dfd911ff18b1114e64d9e963c10a7a5b218"
    decision: same-version
  - root: "event:review-gated/result-prepared"
    previous: null
    after: "13881311db106a08b31c5937ff9cf92f4451e64c12949a229fafc8ecc496969e"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing RG state events remain readable. Prepared results are not exposed until a matching confirmation records that their preparation passed the Session flush barrier. Earlier readers reject the two new required event discriminators rather than silently ignoring them; a confirmed marker already written before a later flush failure is not rolled back.

<a id="verification"></a>
## Verification

Real JSONL recovery tests cover pending and confirmed reviewer and worker results, preparation failure, and disposal. Projection tests cover checkpoint replay, mismatched and duplicate confirmation, and fork boundaries.

<a id="dev-note"></a>
## Dev Note

None.
