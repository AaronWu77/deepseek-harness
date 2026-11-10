---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-09-rg-local-git

English | [中文](2026-11-09-rg-local-git.zh.md)

## Summary

Adds required local Git delivery authorization, candidate, role binding, and operation state events.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-09-rg-local-git
baseline: false
changes:
  - root: "event:review-gated/git-state"
    previous: null
    after: "e46a4172a641805a1709cdb2eefcd3abd86b05d95126f04b485bcb8eb1927c97"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing Sessions have no Git grant and retain their prior RG policy. Current readers recognize the distinct required event and validate its versioned payload; readers without this discriminator reject the event rather than ignore delivery authority. Interrupted operations are not replayed. No Session generation is overwritten.

<a id="verification"></a>
## Verification

The local Git projection test exercises full replay and checkpoint suffix restoration, legacy Sessions without Git authorization, and fail-closed invalid event data; 4 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
