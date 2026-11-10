---
kind: upgrade-guide
description: "Session flush requires an explicit durable acknowledgement from the bound writer."
---

# Session flush durability acknowledgement

English | [中文](guide.zh.md)

## Change

`ctx.sessions.flush(session)` now returns `true` only when a listener explicitly acknowledges durable storage for the exact Session. A listener that returns nothing is an observer, not proof of persistence. Missing acknowledgements cause the session checkpoint policy, Review-Gated delivery, and other consumers that require durability to refuse dependent work.

## Migration

1. Use a persistence backend that binds the live Session to its owned writer. The built-in JSONL backend and AgentLoop perform this binding for newly created and resumed agents.
2. For a custom backend, implement the optional `SessionHandle.bindSession(session)` capability. The owner must write the complete existing Session prefix first and bind immediately before publication, with no intervening Session appends. Route bound events only to the exact Session and keep the binding until the writer closes.
3. Return `SESSION_FLUSH_DURABLE` from `@deepseek-ai/dsh-session` only after the still-owned bound writer has drained and flushed the requested Session. Observers should return nothing. Providers without this capability cannot acknowledge a live checkpoint.
4. If your caller depends on persistence, check the boolean returned by `ctx.sessions.flush(session)` and handle `false` as unconfirmed; handle thrown failures without assuming partial writes were rolled back.
5. If ACP, goal continuation, Agent Teams, translation, manual compaction, or live log export refuses work, verify the Session writer binding and inspect any partial effects before retrying.

This change does not rewrite Session logs. See the [persistence contract](../../../../packages/session/session-persistence/README.md) and [checkpoint policy](../../../../packages/session/session-checkpoint-policy/README.md) for ownership and failure behavior.
