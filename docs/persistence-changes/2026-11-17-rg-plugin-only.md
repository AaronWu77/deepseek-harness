---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-17-rg-plugin-only

English | [中文](2026-11-17-rg-plugin-only.zh.md)

## Summary

Withdraws the fork-local required Session events that carried Review-Gated task state, claim, admission, Git delivery, and model-selection policy, so a plugin-only Review-Gated build adds no required event discriminator.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-17-rg-plugin-only
baseline: false
changes:
  - root: "event:agent/admission/confirmed"
    previous: "2026-11-10-rg-admission-claim"
    after: null
    decision: same-version
  - root: "event:agent/admission/opened"
    previous: "2026-11-10-rg-admission-claim"
    after: null
    decision: same-version
  - root: "event:agent/claim/intent"
    previous: "2026-11-10-rg-admission-claim"
    after: null
    decision: same-version
  - root: "event:agent/claim/settled"
    previous: "2026-11-10-rg-admission-claim"
    after: null
    decision: same-version
  - root: "event:model/selection-policy"
    previous: "2026-11-08-rg-model-pools"
    after: null
    decision: same-version
  - root: "event:review-gated/direct-task-prepared"
    previous: "2026-11-10-rg-admission-claim"
    after: null
    decision: same-version
  - root: "event:review-gated/git-state"
    previous: "2026-11-09-rg-local-git"
    after: null
    decision: same-version
  - root: "event:review-gated/result-confirmed"
    previous: "2026-11-09-rg-result-confirmation"
    after: null
    decision: same-version
  - root: "event:review-gated/result-prepared"
    previous: "2026-11-10-rg-admission-claim"
    after: null
    decision: same-version
  - root: "event:review-gated/state"
    previous: "2026-11-10-rg-admission-claim"
    after: null
    decision: same-version
  - root: "event:review-gated/task-prepared"
    previous: "2026-11-10-rg-admission-claim"
    after: null
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The writer version is unchanged because no released generation is moved, deleted, or rewritten. Review-Gated now records its durable facts as ignorable `plugin:review-gated/*` records, which current readers drop when a consumer is absent. The withdrawn discriminators were required on read: a Session that contains them is refused by the current reader instead of being interpreted with missing state. Export or inspect such a Session with the build that wrote it before discarding it. No downgrade path exists.

<a id="verification"></a>
## Verification

Aggregate typecheck passed five gates; the Review-Gated package suites passed 677 tests with two skipped; persistence catalog regeneration and this acknowledgement pass `verify-persistence-changes`.

<a id="dev-note"></a>
## Dev Note

None.
