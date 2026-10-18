---
description: "Opt-in RG presets for one main conversation with optional workers and an independent reviewer, using Persona and prompt guidance without extra permission gates."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-review-gated

English | [中文](README.zh.md)

## Summary

Add three opt-in Agent presets: RG coordinates work in one conversation with optional worker and reviewer subagents. Persona defines each role; additive guidance tells the coordinator when to delegate and review. Existing presets, permissions, and approval rules do not change, and no tool or completion gate is added.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Select the presets

This experimental bundle is not part of the shipped Official catalog. In a source checkout, install it into the active profile with `dsh plugin --profile web add <absolute path to packages/experimental/review-gated>`, or install the Plugins page's local target `link:<absolute path>`, then restart the Web host. Start a new session and select the **RG** Agent preset. The **RG Worker** and **RG Reviewer** presets are started by the coordinator through `rg_worker` and `rg_reviewer`; they are not selectable as session presets.

For a custom profile, install the bundle with `dsh plugin --profile <name> add @deepseek-ai/dsh-experimental-review-gated`, then select RG in the new session.

Existing sessions keep the preset they started with. Switching a session after its first turn is not part of this bundle. Only **RG** appears in the selector; the two role presets are `selectable: false` and remain resolvable for the coordinator's child tools.

### What you get

The coordinator keeps the task, clarifications, progress, and final answer in one conversation. It may work directly or delegate a bounded task to RG Worker. After integrating and validating a substantive change, it normally starts RG Reviewer for an independent check, then fixes supported findings or explains why it rejects one. Direct human requests to skip review are allowed and must be reported.

The three role presets share the same unrestricted PTC tool group, including shell, filesystem, web, jobs, plans, and subagent controls. RG adds no permission restriction: the reviewer's default of inspecting rather than editing is prompt guidance, not an enforced sandbox. Existing safety, approval, plan-mode, and Host subagent depth limits still apply.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) inserts three `@deepseek-ai/dsh-agent-preset` declarations without targeting an existing preset. Each declaration mounts a scoped `@deepseek-ai/dsh-persona` row and the shared PTC tool group above. Only the `rg` declaration mounts the coordinator guidance plugin and two ordinary `@deepseek-ai/dsh-tool-subagent` instances whose `agentPreset` values select the worker and reviewer.

[`src/index.ts`](src/index.ts) registers one additive system-prompt section within the coordinator's preset scope. It never uses `complete`, and it never registers the deployment persona slot, so the selected Persona and first-party guidance remain in force. Its only configuration is `maxReviewRounds`, which the guidance renders as an advisory review budget. The plugin does not intercept tool calls, completion, or subagent lifecycle.

Role selection uses in-process spawn, which is the only backend that accepts `agentPreset`; fork cannot change a child's persona. Named tools share the existing `send_message`, interrupt, and child-listing controls because routing uses the invoking Agent and child id rather than the originating tool name.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- Persona — the scoped role row each preset mounts.
- Agent presets — declarations, activation, and session binding.
- Subagent delegation — activation, messages, cancellation, and child presets.
- Experimental group map — optional bundles and publication policy.

-----

<a id="model-experience"></a>
## Model Experience

### Coordinator guidance

#### What the model sees

The coordinator model receives the stable `review-gated:coordination` guidance section described above, plus its selected Persona and the shared tool guidance. Worker and reviewer models receive their own Persona and the same tool guidance, but no RG coordination section. Child completion notices and tool results come from the existing subagent runtime.

#### Token effect

The coordinator adds the fixed guidance text once per assembled request; the configured budget is substituted into that text. The worker and reviewer presets add only their Persona text. Every request also carries the unchanged tool schemas of the shared PTC group.

#### KV Cache effect

The selected preset's Persona and guidance are stable for its revision, so they do not invalidate the cached prefix between turns. Enabling or disabling the bundle, changing the budget, or switching presets changes the request prefix once. Existing sessions keep their preset revision until they are replaced.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The review step is a prompt convention, not an enforced gate. The coordinator can deliver without review, and the runtime does not verify that a claimed review happened.
- All three roles receive the same tools. A reviewer can edit files or run commands despite its default instruction not to; when that happens, the coordinator must report and treat the changes as new work.
- The coordinator may work directly and may skip delegation for small tasks. Nothing forces a separate worker or reviewer to start.
- The review budget is advisory and counts attempts only as the model reports them; a failed launch, cancellation, or inconclusive report is not a pass but is not machine-counted.
- Role selection requires in-process spawn. Forked children inherit the parent preset and cannot switch to RG Worker or RG Reviewer.
- Recursive delegation beyond the Host's configured `subagent.maxDepth` is rejected by the existing runtime; RG does not raise it.
- The declarations require an Agent-preset registry. Web and Desktop provide one; a custom profile must mount `@deepseek-ai/dsh-agent-preset-registry` before this bundle can activate RG.
- Existing sessions retain their starting preset and do not gain RG guidance.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The bundle deliberately duplicates the shipped PTC tool list into each role instead of sharing a YAML anchor: preset declarations are independently activated and later patches replace whole configurations, so a shared mutable object would couple revisions. Keep the three lists synchronized when the shipped PTC tools change. The guidance plugin owns no state and only renders its validated budget.

</details>
