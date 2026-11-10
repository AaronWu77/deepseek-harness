---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-10-rg-admission-claim

English | [中文](2026-11-10-rg-admission-claim.zh.md)

## Summary

Add required events for exclusive task admission, direct-task preparation, and recoverable input claims.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-10-rg-admission-claim
baseline: false
changes:
  - root: "event:agent/admission/confirmed"
    previous: null
    after: "78ad4cc37ecf00e0ea58dc615c29a746390c7bd6abff9851e309a793b79f8cf4"
    decision: same-version
  - root: "event:agent/admission/opened"
    previous: null
    after: "c6cf9b044710990419e1e0657e97f6eced41c02b887a5e5d5f066d1376f7a460"
    decision: same-version
  - root: "event:agent/claim/intent"
    previous: null
    after: "0f4158b7e8acc7c908f8340d37271a423e7258a2118bbc51e8137e10af784bd3"
    decision: same-version
  - root: "event:agent/claim/settled"
    previous: null
    after: "77cb3ea6b67429b922a659bb824a66ceb1ebc8d5fba797963e332d57d668fcbd"
    decision: same-version
  - root: "event:review-gated/direct-task-prepared"
    previous: null
    after: "1b3368b5400def24c17c15e5ee0b3ba507a3219bdee2e6dc6000f1116e0a9649"
    decision: same-version
  - root: "event:review-gated/task-prepared"
    previous: null
    after: "3aeac8d4fae4ccb993ae47ac2eca5606ae3c808e7d99f93de6ae4537fa747c6c"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Current readers accept earlier logs. Older readers refuse each new required event rather than interpreting the new protocol; the first admission event precedes explicit task preparation, and claim intent precedes input removal and direct-task preparation. Unconfirmed or interrupted work is not automatically replayed. A failed flush does not establish whether its event reached storage.

<a id="verification"></a>
## Verification

The Agent loop suite passed 539 tests with one skipped, including real JSONL prefix, cancellation, fork, and checkpoint tests. The RG admission and legacy projection tests cover task preparation and uncertain receipt-only history.

<a id="dev-note"></a>
## Dev Note

None.
