---
kind: upgrade-guide
description: "RG task and input recovery adds required Session events and parks uncertain inputs."
---

# RG input recovery requires current Session readers

English | [中文](guide.zh.md)

## Change

RG records task admission, protected input claims, and direct-task preparation as required Session events. Readers that do not recognize these events reject the affected log. A first direct human task is created only after all pre-step preprocessing accepts that input; a rejected, empty, cancelled, or failed step creates no task, and an over-limit task stops before the model. An interrupted or uncertain input is retained for inspection rather than automatically replayed; a failed flush does not establish which records reached storage.

## Migration

1. Upgrade every application or plugin that reads an affected RG Session to a version that recognizes the required events. Do not open that Session with an older reader.
2. Use a Session persistence backend that acknowledges the exact bound writer, as described in the [flush acknowledgement guide](../session-flush-ack/guide.md).
3. If RG reports an uncertain, rejected, or empty input, inspect the retained input preview, any pending inbox items, the Session, and the workspace before proceeding. The full input may not have been saved, and a model or pre-step may already have performed work. Start a new RG Session and resubmit only after deciding that a retry is safe.
4. If a custom Agent implementation is used with RG, implement its input admission and protected-claim capabilities or use the standard Agent loop. Confirm that the RG status view connects and no uncertainty warning remains before starting dependent work.

The [persistence change record](../../../persistence-changes/2026-11-10-rg-admission-claim.md) describes reader compatibility.
