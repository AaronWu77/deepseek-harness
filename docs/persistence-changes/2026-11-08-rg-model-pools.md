---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-08-rg-model-pools

English | [中文](2026-11-08-rg-model-pools.zh.md)

## Summary

Adds required Session model-selection policies, Review-Gated policy/task/report state, and the review-gated message source.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-08-rg-model-pools
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "d8bc9dd2a347c71dbc7b200bdc6345974b073602f94af4328eb6e85e79068a84"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "32c9e21b7693be4ebd658b3b8a1cfd65249706e8b17cdfe7698f5015adf94fca"
    decision: same-version
  - root: "event:model/selection-policy"
    previous: null
    after: "f35bf4de57224b74d6aac41fab3b3b1b28446a9b71cdb5ae760f6e8521c2b0e9"
    decision: same-version
  - root: "event:review-gated/state"
    previous: null
    after: "85d752f28042235947ac8a59e6bd83d0cb609cc489f85d220fff5616284ab0b5"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "a0d76339551efd209f9bcdd1d6eecb9a0e173ead17f2bfdf87aecd5ca2616825"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "c785c157069d6cbbcb8ebc2dcdd7cb3b9f3ee605f1913af1e66d8aa8cf49056e"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The writer version remains unchanged. Current readers accept existing Sessions: absence of a model policy keeps ordinary selection unrestricted, while an older RG Session without its frozen RG policy cannot acquire role authorization and must be replaced before new RG work. Older readers cannot silently ignore the new authorization or reports: model/selection-policy and review-gated/state are distinct required-on-read event discriminators, and review-gated is a distinct message-source discriminator. Their closed catalogs reject these unknown required variants before execution. No committed Session generations are moved, deleted, or rewritten; there is no downgrade fallback. The new model policy payload is an object containing the complete policy or null, and RG state has an explicit version field.

<a id="verification"></a>
## Verification

Session format catalog, V3-to-V4 reader, and persistence schema snapshot suites: 26 files and 431 tests passed. Generic model-selection policy tests: 17 passed; model API and selector regression: 121 passed. The RG shipped-headless composition tests passed with distinct main/worker/reviewer routes and PTC-only requests. The new keyless RG scenario recorded, refreshed, and replayed successfully; typed identity and normalization suites passed 98 tests. During scenario adaptation the strict reader rejected the unregistered review-gated/state event instead of dropping it; regenerating the current catalog admitted it.

<a id="dev-note"></a>
## Dev Note

None.
