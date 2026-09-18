# Agent Note: Stable scheduler identity across source and profile entry points

Status: implemented

English | [中文](2026-09-19-stable-tool-scheduler-identity.zh.md)

## Problem

Source `dsh` launches run through `tsx/esm`, whose `paths` projection can load a workspace package's source entry. Profile plugins resolve package exports to `lib`. `@deepseek-ai/dsh-agent-loop` and `@deepseek-ai/dsh-tools` therefore can be evaluated from different entry points in one Node process. `TOOL_RUNTIME_SCHEDULER` used a module-local `Symbol()`, so agent-loop looked up a different property from ToolRuntime's scheduler and every model tool call failed before `prepare`.

## Decision

`TOOL_RUNTIME_SCHEDULER` uses `Symbol.for('@deepseek-ai/dsh-tools.scheduler')` while retaining its internal unique-symbol type. The key is a process-local registry name rather than module-instance identity, so source and profile entry points address the same scheduler property. The scheduler remains internal and omitted from generated service APIs.

## Alternatives considered

**Make the source launcher resolve every package to source.** Rejected: it would expand startup resolution changes across the full profile dependency graph and make profile-loaded packages depend on source-tree entry semantics.

**Make the profile loader resolve every package to `lib`.** Rejected: it would remove source launch's zero-build path and mix launcher behavior with package artifact availability.

**Add a missing-scheduler fallback in agent-loop.** Rejected: it would hide module identity defects and could select an unrelated property instead of preserving one scheduler contract.

## Consequences

Source and profile package entry points can share this scheduler capability without requiring one module instance. Other runtime exports that rely on object or class identity remain subject to the existing source/artifact launch rules; this decision covers only the symbol-keyed scheduler. The tools test asserts the key is the global registry value, and the Web smoke verifies a real PTC tool call completes instead of failing at `prepare`.
