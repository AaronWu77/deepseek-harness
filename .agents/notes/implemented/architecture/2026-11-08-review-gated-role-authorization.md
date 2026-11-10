# Agent Note: Frozen role authorization and bounded RG attempts

Status: implemented

English | [中文](2026-11-08-review-gated-role-authorization.zh.md)

## Problem

A configurable execution-and-review workflow needs model choices that remain attributable to one task and do not change when deployment settings or global defaults move. A selector can hide models without stopping another request path from selecting them. A child id or ordinary completion message also cannot establish that an independent review produced a valid report for the current files.

## Decision

Review-Gated owns its optional business policy. It captures one complete configuration for a new Session, including role candidates, defaults, reasoning choices, limits, and resolved reviewer inheritance. The generic Session model policy owns exact model-selection restrictions; adapters remain the owners of route availability. The main Agent may switch within its frozen pool without changing the global default. Each managed role attempt binds one chosen route and requires its live parent/task/run reservation at request execution. A completed child history is not new execution authority.

One existing subagent manager owns creation, cancellation, structured capture, and cleanup. Fresh one-shot role presets receive explicit bounded handoffs, not the parent conversation. This preserves independent personas and PTC while avoiding a second Agent lifecycle. Admission and cleanup have different lifetimes: stopping new work cannot prevent an accepted attempt from recording its terminal cancellation. The parent Agent and RG service both retain accepted work until child disposal and durable parent-result settlement finish; a teardown failure must not skip either wait. Cancellation authority follows the live parent reference, not identifiers in restored task records. The underlying [activation ownership decision](../simplification/2026-09-17-unified-subagent-activations.md) remains in force.

A task reservation consumes an attempt before execution, and cancellation or failure does not refund it. Only an explicit human task action renews counters. Structured reports require successful inner capture and successful outer PTC execution; normal child completion is insufficient. Complete parent-result text, including error diagnostics, is bounded before it is retained or sent. An oversized or malformed result cannot become a truncated pass.

Review evidence includes the exact work revision and a bounded content fingerprint of the declared file scope and relevant Git metadata. An unavailable or changed identity makes the review unverified or stale rather than preserving an earlier pass. Durable reservations and reports do not replay resources after a restart. Required event discriminators make unsupported readers refuse the new authorization data instead of discarding it; the [persistence acknowledgement](../../../../docs/persistence-changes/2026-11-08-rg-model-pools.md) owns that compatibility review.

## Alternatives considered

- **Use global model defaults or reread configuration on every call.** Either changes the meaning of an existing Session and can expand authorization without a new human configuration decision.
- **Enforce choices only in the UI or model prompt.** Direct service calls and default resolution remain execution paths, so the final request needs its own check.
- **Reuse a continuable child as the next attempt.** It retains previous role context and can obscure whether new work consumed an attempt. Fresh roles keep task attribution explicit; normal continuable delegation remains available outside RG.
- **Add an RG-specific Agent loop, child manager, or Job registry.** Each duplicates existing cancellation and cleanup ownership without an independent execution backend.
- **Treat any review-shaped text as a pass or silently keep a partial scope.** Neither establishes report ownership or current content identity.

## Consequences

The machine enforces authorization, attribution, accepted attempts, formal-report ownership, and review staleness. It does not establish code correctness, force every answer through review, make the reviewer a read-only sandbox, or impose a monetary budget. Existing Host permissions remain authoritative. Freezing policy also means configuration edits apply to new Sessions, and interrupted work requires inspecting partial effects rather than automatic replay.

## Verification

Real-service tests cover alternate request paths, selected-route binding, cold-child refusal, cancellation accounting, flush barriers and failures, plugin teardown, and interrupted recovery. Recorded headless Sessions pin fresh role personas, PTC-only request tools, structured reports, and task history. Scope tests retain file-content differences and refuse incomplete identities; result tests include exact limits, tiny limits, and malformed-report error amplification.

## Related decisions

The [fork-prefix decision](2026-08-10-fork-children-stay-one-shot.md) retains its independent cache and inherited-context rationale. RG uses fresh roles instead. The [routed-model context decision](2026-07-20-routed-model-context-and-compaction-policy.md) continues to assign capacity and routing facts to adapters; frozen authorization is a consumer policy, not another model catalog.
