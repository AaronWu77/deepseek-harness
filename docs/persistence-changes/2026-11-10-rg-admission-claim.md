---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-10-rg-admission-claim

English | [中文](2026-11-10-rg-admission-claim.zh.md)

## Summary

Add required events for exclusive task admission, direct-task preparation, and recoverable input claims, and record whole-workspace review scope identity.

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
    after: "528503dbc80ad1aca5d412c200fe596c04d848b701fdaa9716499b15f2a39b5e"
    decision: same-version
  - root: "event:review-gated/result-prepared"
    previous: "2026-11-09-rg-result-confirmation"
    after: "1cf8519b6f55fb60461234fbc39639f8c983d96f258e869ea6b224cf10bbae7d"
    decision: same-version
  - root: "event:review-gated/state"
    previous: "2026-11-08-rg-model-pools"
    after: "cdb9c4ff160de1a7178b6b56cd07a3628dcfcdb78c01ca364e8bec100f70c25c"
    decision: same-version
  - root: "event:review-gated/task-prepared"
    previous: null
    after: "c8770292671017732975cd1ea11050c392285e9936fb254463fb7495211329a9"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Current readers accept earlier logs. Older readers refuse each new required event rather than interpreting the new protocol; the first admission event precedes explicit task preparation, and claim intent precedes input removal and direct-task preparation. Unconfirmed or interrupted work is not automatically replayed. A failed flush does not establish whether its event reached storage. Review scope records gain a tree fingerprint and diagnostic; a record written before those fields existed reads as having no tree identity, which cannot authenticate a pass.

<a id="verification"></a>
## Verification

The Agent loop suite passed 539 tests with one skipped, including real JSONL prefix, cancellation, fork, and checkpoint tests. The RG admission and legacy projection tests cover task preparation and uncertain receipt-only history. The RG scope tests cover whole-workspace drift, budget exhaustion, and generation upgrades.

<a id="dev-note"></a>
## Dev Note

None.
