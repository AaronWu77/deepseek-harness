---
description: "Configure RG role model pools and bounded workers and reviewers while keeping delivery in one main conversation."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-review-gated

English | [中文](README.zh.md)

## Summary

Keep requirements, progress, and delivery in one RG conversation, with optional workers and independent reviewers. Configure each role’s model candidates, defaults, and reasoning choices before opening a new session. Managed roles return structured reports and consume bounded attempts. The main agent can work directly; review is neither a delivery gate nor a permission grant. This experimental bundle is opt-in.

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

Open **Settings → RG models** to configure role models. Select main and worker model candidates and one default per pool. Reviewer configuration either inherits main or uses its own pool. Set reasoning per candidate: omission uses the adapter default, never another role’s effort. Merely listing models does not authorize them or send a model request. The **RG models** row uses the branch glyph in the Settings navigation, so it is distinct from the sections that keep the default gear.

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

To use local Git delivery, mount the [Forge bundle](../forge-bundle/README.md) or otherwise provide the worktree service with the existing filesystem, subprocess, sandbox, and sandbox-policy services. Open an RG task in a Git checkout. Before any role attempt, open the RG task view from the input area and explicitly authorize repository-relative paths while the main Agent is idle. This authorizes local task branches and commits only; it does not authorize a push, PR, merge, or remote access.

The Host pins the source checkout's current committed HEAD, leaves the main Session directory and its staged, unstaged, and untracked changes in place, and provisions a linked task worktree without copying those changes. The worktree pool and shared Git metadata may be changed. Normal Git commit hooks run under the inherited subprocess policy; a hook or signing failure stops finalization. Each worker and reviewer handoff must cover the entire authorized scope. After a formally completed worker report, the Host validates actual changes and creates a local commit; a fresh reviewer inspects an independent detached checkout of that exact candidate. The task view identifies the worktree, candidate commit, and worker-reported validation. Recheck compares the worker and reviewer checkouts with the recorded base, head, tree, and scope identity; a mismatch makes the reported pass stale. These checks are sequential, not an atomic snapshot or a write restriction: another process can change either checkout after it was checked.

Cancellation, failed Git operations, interruption, and unknown commit outcomes retain worktrees, branches, index entries, and commits for inspection. No automatic stash, reset, removal, push, or PR is performed. After inspecting retained resources, the owner can explicitly leave local delivery without deleting them; leaving does not reset attempt budgets. Checkout creation and commit use the current Session policy, including permissions for the shared Git metadata, and never enlarge its writable roots.

### Work and review

The default flow is direct investigation and a human-confirmed design when requested, optional grouped worker implementation, integration and available acceptance checks, then one delivery review. A worker does not automatically require its own reviewer. With two reviewer attempts, preserve one for repair and re-review. Handoffs include actual validation and known gaps. Routine proposals do not need review; designs that are final deliverables and human-requested intermediate reviews may be reviewed. When only one attempt remains, the task view and `rg_status.workflow` warn that no re-review capacity will remain.

The main agent may answer or implement directly; delegation is optional. Its first direct human task starts the attempt counters only after all pre-step preprocessing accepts that input; a rejection, empty result, cancellation, or failure creates no task, and an over-limit task stops before the model with the original input retained for inspection. Trusted same-process preprocessing may rewrite the admitted text. Clarifications do not reset them. One task covers the complete human deliverable, including investigation, design, implementation, fixes, and validation; do not split intermediate steps to obtain fresh budgets. Use the task view’s explicit **Switch to a new task** action while idle to start an independent task with fresh counters.

Through PTC, `rg_worker` and `rg_reviewer` accept complete handoffs: objective, acceptance criteria, exact file/directory scope, constraints, discovered facts, and validation evidence or commands. Each accepted call reserves an attempt before starting a fresh child, with no parent conversation history. The selected model and reasoning are fixed for that attempt; every role request requires its live reservation. Reopening a completed role history grants no new execution. A returned child id confirms startup only. Workers report changes, validation, and unverified areas; reviewers report a verdict, inspected scope, evidence-based findings, validation, and unverified areas. Both submit formal reports through `tools.structured_output` inside `run_code`. Completed roles cannot receive follow-up work or delegate further.

Only one role runs at a time. The main agent must keep its workspace work read-only until settlement; its direct write/edit/command tools are blocked during a role run. Completed results are prepared in the Session log and become visible only after the preparation passes its durability barrier and a matching confirmation is recorded; confirmed results wake the parent after saving. The complete result notice, including metadata and diagnostics, must fit `maxReportChars`; overflow becomes a failed attempt with no retained successful report, and very small limits abbreviate the failure diagnostic. Failed, cancelled, interrupted, and inconclusive accepted attempts consume budget without refunds. Exhaustion requires reporting unresolved work; only a human can start a new task budget. Attempt limits are not token or spending caps.

`rg_status.workflow` derives remaining worker/reviewer attempts, last-attempt advice, unresolved exhaustion, and evidence-only inconclusive review from the existing task. Concrete defects remain in `findings`; unavailable acceptance evidence remains in `unverified`. Evidence-only inconclusive is not a pass. When review attempts are exhausted without a current reported pass and no role remains active, RG disarms the optional goal service at turn stopping, after scope recheck. The goal stays active but cannot automatically queue more rounds; RG neither completes it nor resets the budget. A human must inspect unresolved work before deciding what to do next. The task view shows the last-attempt and exhaustion warnings without treating a stale pass as valid.

Choose **Classic**, **Flow**, **Focus**, or **Trace** at the top of the RG sidebar. Classic keeps the original cards; Flow emphasizes role connections, Focus puts the current role first, and Trace uses compact rows. The choice is stored in this browser and shared by RG sessions. The three compact views keep model information behind details buttons. All views use the same task facts, reports, and actions; switching views does not spend attempts, change the task, or discard an open task draft.

The input area shows an **RG task** button and at most one current status or actionable warning. Processing does not expose save or claim records there; open the task view for input recovery details. Recovery notices group the current status and a **View input** button; the retained preview and recovery instructions stay collapsed until opened. Open **RG task** to see the main role and the active and latest worker and reviewer attempts, deduplicated by run ID. The view is not a complete history; role attempts run one at a time. It shows task/revision, attempts, configuration identity, admitted selections, actual last-request versus next model, and committed reports; use the task and attempt details buttons for technical identifiers. The sidebar task summary is read-only. A reviewer’s pass is labelled **Reviewer reported a pass**, not verified correctness. Scope changes invalidate it; use **Recheck reviewed files** or `rg_status` before relying on it. A Git review without its matching candidate and reviewer binding is displayed as stale, including while that evidence is unavailable. The view provides no real-cost accounting or cost guarantee. When the sidebar service is unavailable, the input-area status retains the task controls. The status view follows Host-confirmed state and durable history. While disconnected, or while Session identity is unavailable, it shows an unavailable notice and disables actions; an ordinary Session with no loaded RG projection can also show that notice temporarily. Reading cold history requires SessionQuery. Process recovery marks an orphaned active run interrupted rather than restarting it. Disposing the parent or disabling/unloading RG cancels owned roles; both lifetimes wait for child disposal and parent-result persistence to settle before releasing dependencies. Disabling/unloading also blocks further RG requests. A result-save failure stops dependent work and requires inspecting the session and workspace. Switching tasks requires an idle Agent with no queued input; resolve pending input first. If a new-task save or delivery is uncertain, that task remains blocked for inspection; a failed flush cannot establish which writes reached storage.

-----

<a id="source-and-attribution"></a>
## Source and attribution

The [package manifest](package.json) declares bundle, client, repository, and license metadata.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [bundle patch](cordis.patch.yml) inserts one Host settings owner and three Persona-based presets. The [runtime](src/runtime.ts) owns frozen policy, request authorization, durable task reservations, and report settlement; the existing subagent manager owns the local child lifecycle and inherited Host permissions. The [role contribution](src/role.ts) adds scoped guidance and main-only RG tools without replacing Persona or the PTC executor.

[Task operations](src/task.ts) count attempts at reservation and reject overlapping or unrelated settlements. [Scope inspection](src/scope.ts) fingerprints bounded handoff paths and local Git metadata before/after review and on recheck. A changed or unverifiable scope cannot establish a current reported pass. The [client controller](src/client/config-controller.ts) keeps only page-local drafts. `RgView` combines Session projections with live save status, and `RgClaimReport` bounds the model-visible recovery preview.

RG-owned durable facts use ignorable `plugin:review-gated/` records defined by the [record schemas](src/records.ts). The [RG projection](src/projection.ts) and [Git projection](src/git-projection.ts) validate recognized payloads and remain failed after malformed owned records; unrelated plugin records do not change their state. Result preparation and identity-only confirmation remain separate durability facts, and Git state retains explicit clear-to-null records. Replaying records does not start roles or perform Git operations.

An RG `claim` record has phase `intent` and retains the original input batch, turn, and step. An eligible human input opens projected `taskAdmission` with the exact intent sequence and no task identity. This means only that the open batch may become a task; its presence alone does not mean a task save is pending. Optional `target` fields are diagnostic and are never inferred when absent.

`task-prepared` binds the new task and original objective to that exact intent sequence and message identity, sets `taskAdmission.taskId`, and marks the save uncertain. `direct-task-prepared` instead consumes the admission while retaining the bounded original objective. Explicit new-task submission uses ordinary `followup`; the pre-step owner writes the intent and preparation and flushes both before delegating.

An RG `claim-settled` record has phase `settled` and references the exact open intent. `entered` requires the matching step start and complete logged `user/message` batch; only this evidence clears a prepared task's uncertainty. `rejected` and `empty` cannot confirm a prepared task. A missing settlement remains uncertain, and malformed or orphan settlement fails closed. Core claim, admission, and inbox receipts do not establish RG acceptance.

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
- A cancelled, interrupted, or unsettled input can remain blocked for inspection. The status view shows a bounded preview when available; a failed flush may leave the full input absent from the log. Pre-step may already have invoked a model or tool. Inspect the Session and workspace, then start a new RG Session and resubmit only if a retry is safe. A complete `entered` settlement found after restart can be valid even when the earlier flush reported failure.
- Cold readiness comes from RG's folded claim and task-receipt evidence, not consumer-side log replay or core Agent claims. A clean null RG state renders nothing; `failed: true` means recovery is unavailable and actions stay disabled. The top-level `ready` is authoritative; `taskReceipt` is diagnostic only—never gate on this field. Generic or legacy task state stays unproven until an exact prepared-input settlement establishes receipt, even after its claim clears.
- Managed roles require local spawn, cannot use fork or continued activation, and do not increase the Host’s configured subagent depth. This bundle does not retrofit ordinary sessions or authorize legacy RG sessions.
- RG cannot prove that submitted input reached durable storage before a model request. The Host's flush acknowledgement is a core signal, so a plugin-only build treats a completed flush as sufficient; mount a persistence backend that stores every event before the request and inspect the Session if a submission appears lost.
- Resuming a Session whose task admission was interrupted by parent disposal can leave the resumed turn waiting without settling. The interrupted Session stays inspectable and refuses new RG work; open a new RG Session instead of resuming it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Each role owns an independent PTC configuration because preset declarations activate separately and later patches replace whole configurations. Keep common tool contributions synchronized.

</details>
