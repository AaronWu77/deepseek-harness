---
description: "Configure RG role model pools and bounded one-shot workers and reviewers while keeping delivery in one main conversation."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-review-gated

English | [中文](README.zh.md)

## Summary

Keep requirements, progress, and delivery in one RG conversation, with optional workers and independent reviewers. Configure each role’s model candidates, defaults, and reasoning choices before opening a new session. Managed one-shot roles return structured reports and consume bounded attempts. The main agent can work directly; review is neither a delivery gate nor a permission grant. This experimental bundle is opt-in.

## Table of Contents

- [Use this package](#use-this-package)
- [Source and attribution](#source-and-attribution)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Configure before starting

Install this opt-in bundle into a profile through [Plugin Manager](../../boot/plugin-manager/README.md). It is not in the shipped Official catalog. The profile must provide an Agent-preset registry; Web and Desktop already do. Only **RG** is selectable; **RG Worker** and **RG Reviewer** are reserved for managed child starts. For existing installations and automation, follow the [upgrade guide](../../../docs/upgrade-guide/v0.2.2-rc.1/rg-model-pools/guide.md).

Open **Settings → RG models** to configure role models. Select main and worker model candidates and one default per pool. Reviewer configuration either inherits main or uses its own pool. Set reasoning per candidate: omission uses the adapter default, never another role’s effort. Merely listing models does not authorize them or send a model request.

The single Host settings entry `rg-settings` owns the entire volatile `settings` document. Save submits all pools and limits together against the draft’s original revision. Conflicting Host edits block saving; discard and reload the current values. A lost response is not success unless the Host mirror contains the submitted document. Switching sections or closing Settings keeps the draft while the RG client remains active. Reconnecting or losing settings access discards the draft and suppresses late save results; it does not undo an already committed Host write. If this happens during a save while the RG client remains active, its outcome remains unknown and further saves stay blocked until you confirm that you have checked the Host settings. A failed refresh can leave displayed values stale. Unloading the RG client or reloading the page clears that local warning, so inspect the Host before retrying. Unavailable saved routes stay visible rather than silently selecting replacements.

| Setting | Default | Meaning |
|---|---|---|
| `configured` | `false` | No model authorization until an explicit valid save |
| `main`, `worker` | Empty candidates; no default | Exact provider/model pools with per-candidate reasoning |
| `reviewer` | `inherit-main` | Copy main configuration at session creation, or use a custom pool |
| `maxWorkerAttempts`, `maxReviewAttempts` | `2` each | Accepted attempts per human task and role |
| `maxHandoffChars`, `maxReportChars` | `16384` each | Complete serialized handoff / parent-result notice character limits |
| `maxScopeFiles`, `maxScopeBytes` | `1024`; `16777216` | Scope inspection entry-count and content-byte limits |

Open a new RG session after saving. Creation freezes model pools, defaults, reviewer inheritance, reasoning choices, and limits; selecting RG in a blank session also initializes this policy. Later settings edits affect new sessions only. Manually switching the main model neither changes the reviewer’s frozen pool/default nor updates the global model default. Requests outside the frozen role choices are rejected. An older RG session without a policy snapshot remains readable but gains no automatic authorization; open a new configured session.

### Local Git delivery

[`RgGitState`](src/git-types.ts) declares the current local delivery state.

To use local Git delivery, mount the [Forge bundle](../forge-bundle/README.md) or otherwise provide the worktree service with the existing filesystem, subprocess, sandbox, and sandbox-policy services. Open an RG task in a Git checkout. Before any role attempt, use the status strip to explicitly authorize repository-relative paths while the main Agent is idle. This authorizes local task branches and commits only; it does not authorize a push, PR, merge, or remote access.

The Host pins the source checkout's current committed HEAD, leaves the main Session directory and its staged, unstaged, and untracked changes in place, and provisions a linked task worktree without copying those changes. The worktree pool and shared Git metadata may be changed. Normal Git commit hooks run under the inherited subprocess policy; a hook or signing failure stops finalization. Each worker and reviewer handoff must cover the entire authorized scope. After a formally completed worker report, the Host validates actual changes and creates a local commit; a fresh reviewer inspects an independent detached checkout of that exact candidate. The status strip identifies the worktree, candidate commit, and worker-reported validation. Recheck compares the worker and reviewer checkouts with the recorded base, head, tree, and scope identity; a mismatch makes the reported pass stale. These checks are sequential, not an atomic snapshot or a write restriction: another process can change either checkout after it was checked.

Cancellation, failed Git operations, interruption, and unknown commit outcomes retain worktrees, branches, index entries, and commits for inspection. No automatic stash, reset, removal, push, or PR is performed. After inspecting retained resources, the owner can explicitly leave local delivery without deleting them; leaving does not reset attempt budgets. Checkout creation and commit use the current Session policy, including permissions for the shared Git metadata, and never enlarge its writable roots.

### Work and review

The main agent may answer or implement directly; delegation is optional. Its first direct human task starts the attempt counters only after all pre-step preprocessing accepts that input; a rejection, empty result, cancellation, or failure creates no task, and an over-limit task stops before the model with the original input retained for inspection. Trusted same-process preprocessing may rewrite the admitted text. Clarifications do not reset them. Use the status strip’s explicit **Start a new task** action while idle to start an independent task with fresh counters.

Through PTC, `rg_worker` and `rg_reviewer` accept complete handoffs: objective, acceptance criteria, exact file/directory scope, constraints, discovered facts, and validation evidence or commands. Each accepted call reserves an attempt before starting a fresh one-shot child, with no parent conversation history. The selected model and reasoning are fixed for that attempt; every role request requires its live reservation. Reopening a completed role history grants no new execution. A returned child id confirms startup only. Workers report changes, validation, and unverified areas; reviewers report a verdict, inspected scope, evidence-based findings, validation, and unverified areas. Both submit formal reports through `tools.structured_output` inside `run_code`. Completed roles cannot receive follow-up work or delegate further.

Only one role runs at a time. The main agent must keep its workspace work read-only until settlement; its direct write/edit/command tools are blocked during a role run. Completed results are prepared in the Session log and become visible only after the preparation passes its durability barrier and a matching confirmation is recorded; confirmed results wake the parent after saving. The complete result notice, including metadata and diagnostics, must fit `maxReportChars`; overflow becomes a failed attempt with no retained successful report, and very small limits abbreviate the failure diagnostic. Failed, cancelled, interrupted, and inconclusive accepted attempts consume budget without refunds. Exhaustion requires reporting unresolved work; only a human can start a new task budget. Attempt limits are not token or spending caps.

The status strip shows task/revision, attempts, configuration identity, actual last-request versus next model, and committed reports. A reviewer’s pass is labelled **Reviewer reported a pass**, not verified correctness. Scope changes invalidate it; use **Recheck reviewed files** or `rg_status` before relying on it. A Git review without its matching candidate and reviewer binding is displayed as stale, including while that evidence is unavailable. The strip provides no real-cost accounting or cost guarantee. The status view follows Host-confirmed state and durable history. While disconnected, or while Session identity is unavailable, it shows an unavailable notice and disables actions; an ordinary Session with no loaded RG projection can also show that notice temporarily. Reading cold history requires SessionQuery. Process recovery marks an orphaned active run interrupted rather than restarting it. Disposing the parent or disabling/unloading RG cancels owned roles; both lifetimes wait for child disposal and parent-result persistence to settle before releasing dependencies. Disabling/unloading also blocks further RG requests. A result-save failure stops dependent work and requires inspecting the session and workspace. Starting a new task requires an idle Agent with no queued input; resolve pending input first. If a new-task save or delivery is uncertain, that task remains blocked for inspection; a failed flush cannot establish which writes reached storage.

-----

<a id="source-and-attribution"></a>
## Source and attribution

The [package manifest](package.json) declares bundle, client, repository, and license metadata.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [bundle patch](cordis.patch.yml) inserts one Host settings owner and three Persona-based presets. The [runtime](src/runtime.ts) owns frozen policy, request authorization, durable task reservations, and report settlement; the existing subagent manager owns local one-shot lifecycle and inherited Host permissions. The [role contribution](src/role.ts) adds scoped guidance and main-only RG tools without replacing Persona or the PTC executor.

[Task operations](src/task.ts) count attempts at reservation and reject overlapping or unrelated settlements. [Scope inspection](src/scope.ts) fingerprints bounded handoff paths and local Git metadata before/after review and on recheck. A changed or unverifiable scope cannot establish a current reported pass. The [client controller](src/client/config-controller.ts) keeps only page-local drafts. `RgView` combines Session projections with live save status, and `RgClaimReport` bounds the model-visible recovery preview.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Agent presets](../../preset/agent-preset-registry/README.md) — selection and post-commit consumer initialization.
- [Subagent delegation](../../../docs/subsystems/subagent.md) — activation, cancellation, and lifecycle.
- [Experimental packages](../README.md) — status and publication policy.

-----

<a id="model-experience"></a>
## Model Experience

### Role guidance and managed reports

#### What the model sees

Main receives `review-gated:main` guidance headed “RG: work and independent review”, its Persona, and PTC bindings including `rg_models`, `rg_status`, `rg_worker`, and `rg_reviewer`. When retained input exists, `rg_status` returns its claim status and a bounded text preview before ordinary task facts. The preview may omit content, and a failed flush does not guarantee that the full input reached the Session log. Children receive their own Persona, the original task and explicit handoff, PTC-only reporting guidance, and a role-specific structured output schema. Committed result notices enter the main conversation; startup receipts are not reports.

#### Token effect

Guidance and tool declarations add request tokens. Handoffs, child requests, structured reports, and parent result notices add task-dependent tokens; smaller role models do not guarantee lower total usage or cost.

#### KV Cache effect

Persona and role guidance are stable within a retained preset revision. Handoffs, reports, and task history extend separate role conversations. Changing the selected main route can change cache reuse; RG makes no cross-model or cross-role cache guarantee.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Review does not block delivery or prove correctness. The main agent must disclose actual validation, the reviewer-reported outcome, inspected scope, and material unverified areas; a direct human request to skip review is allowed and must be reported.
- The reviewer's read-only role is enforced for workspace-mutating tools: `write`, `edit`, `apply_patch`, and `str_replace_editor` are denied for that scope through the shared tool guard, including nested PTC dispatches. Shell confinement is not enforced; a reviewer can still run `bash` or `pwsh` under the existing Host sandbox, so treat any resulting change as new work requiring review.
- A workspace review records a whole-workspace content identity alongside the declared scope. A change outside the declared scope keeps the declared fingerprint and moves the tree identity; the result then reports that the pass covers only the declared scope. The tree identity is a signal, not a gate: when the workspace exceeds `maxScopeFiles` or `maxScopeBytes` it is absent with a diagnostic, so a large repository does not lose every earlier pass.
- Fingerprints cover explicit handoff paths, not every dependency or the truth of a reviewer’s inspected-scope claim. Symbolic links, unsupported files, detected changes during inspection, or exceeded limits produce an unverified scope, never a truncated successful fingerprint. Inspection is not an atomic snapshot: external writes can occur between or after checks. Workspace fingerprints do not include file permissions or executable-mode changes because the filesystem metadata API does not expose them. Older workspace review fingerprints without the current version label are stale and require a new review. Workspace-mode inspection does not verify a linked worktree’s external Git metadata. Local Git delivery instead verifies its canonical linked checkout and commit identity; it rejects ignored untracked files anywhere in either role checkout, symbolic links, submodules, binary or non-UTF-8 changes, hidden index flags, and staged content changed by Git attributes.
- Local Git delivery is a trusted collaboration mode, not a credential or network boundary. Role shell access may independently invoke Git or a forge CLI under the inherited Host policy; the local-only grant constrains the managed RG path, not those other commands.
- RG requires a successful acknowledgement from the Session’s bound writer before dependent work. Configure a persistence backend that supports exact Session binding; a flush observer alone does not acknowledge durability. RG request admission precedes the loop’s `user/message` append, so mount [session checkpoint policy](../../session/session-checkpoint-policy/README.md) to flush the complete request before adapter execution.
- A cancelled, interrupted, or unconfirmed input can remain blocked for inspection. The status view shows a bounded preview when available; a failed flush may leave the full input absent from the log. Pre-step may already have invoked a model or tool. Inspect the Session and workspace, then start a new RG Session and resubmit only if a retry is safe. A confirmed record found after restart can be valid even when the earlier flush reported failure.
- Managed roles require local spawn, cannot use fork or continued activation, and do not increase the Host’s configured subagent depth. This bundle does not retrofit ordinary sessions or authorize legacy RG sessions.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Each role owns an independent PTC configuration because preset declarations activate separately and later patches replace whole configurations. Keep common tool contributions synchronized.

</details>
